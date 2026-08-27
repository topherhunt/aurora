## 13. Aurora and sky

> **Covers:** all three auroras -- the eleven curtain meshes the game draws today, the raymarch lab, and the traced-contour card technique -- plus the sky dome, stars, night-sky banding, and the aurora's fill-rate budget.
> **Read this when:** touching `src/aurora.js`, `src/aurora-patterns.js`, `src/aurora-lab/*`, `src/aurora-cards/*`, or `scripts/check-daynight.mjs`.
> **There are three auroras in this tree and only one of them ships.** `src/aurora.js` is what `index.html` and `v2.html` draw. `src/aurora-lab/*` at `/test-aurora` and `src/aurora-cards/*` at `/test-aurora-v2` are both replacements under development; neither world imports either, and nothing has been promoted out of them yet.
> **Reverted work lives in** `design/history/aurora-rounds-4-6.md` **and is not in the tree.** Everything below is.

**The aurora appears randomly at night, anywhere in the world** -- not gated on altitude. Summits simply give a better view: less terrain occlusion, less atmospheric haze, and a modest intensity boost with elevation.

This is driven by the same low-frequency-noise-over-time mechanism as weather (§10), gated to night hours. Squalls of snow and curtains of aurora both come and go, which makes the world feel like it has moods.

Also on the dome: `src/sky.js` (rewritten), a slowly rotating starfield (`src/stars.js`), and the moon. The wispy drifting cloud layer -- two scrolling alpha-blended layers -- is still outstanding.

### What an aurora actually is

Worth writing down, because nearly every shortcut in all three implementations is licensed by one of these facts.

An aurora is not a light in the sky. It is the **upper atmosphere itself glowing**, along magnetic field lines, where precipitating electrons excite oxygen and nitrogen. Three consequences:

1. **Colour is a function of altitude and nothing else.** Atomic oxygen at 100-150 km gives the 557.7 nm green that dominates; above ~200 km the same oxygen gives 630.0 nm red (long-lived state, only survives where collisions are rare); ionised nitrogen at 80-100 km gives the 428/470 nm blue-violet that shows as the pink-magenta lower hem. So the vertical colour ramp is not art direction -- it is a spectroscopy table, and it is the single strongest cue that what you are looking at is real. Every attempt to key aurora colour off *intensity* instead produces the same tell: the bright parts go yellow-white and the whole thing reads as fire.
2. **All structure is vertical.** The rays are field lines. This is the constraint that decides both shaders: the noise that generates striations must be indexed on distance *along* the arc and must **not** contain an altitude term. One character's worth of mistake there and the whole thing stops being an aurora and becomes coloured fog. The gate asserts it textually.
3. **It is optically thin.** You see straight through it: what reaches the eye is the sum along the line of sight. That means no sorting, no transparency ordering and no depth writes in any of the three, and it means the fold-on-fold brightening where a curtain doubles back on itself is *free* rather than something to model. Two of the three blend additively for that reason. The card technique does not, and the reason is the 8-bit framebuffer rather than the physics -- an unbounded sum clips, and what clipping does to a stack of columns is argued out under that section.

### The shipped aurora: eleven parametric curtains

`src/aurora.js` plus the catalogue in `src/aurora-patterns.js`. **This is the one the game draws.** It is cheap, mobile-friendly, gated in depth, and it is what the lab further down exists to replace.

#### The factorisation

Lawlor & Genetti (2010) is the load-bearing idea: an aurora is a **2D curtain footprint x a 1D altitude deposition profile**. There is no 3D volume to march. What ships is eleven slots of 181 x 10 parametric grid -- **35,640 triangles, one draw call** -- carrying nothing but `(aU along, aV up, aSlot)`. The `position` attribute exists only because three.js requires one and is all zeros; every coordinate is computed in the vertex shader from the band uniforms. That is why the gate mirrors the footprint arithmetic on the CPU rather than reading the buffer, and it is worth the price, because it then checks all sixteen forms instead of one hard-coded arrangement.

#### One shader, one mesh, a table of named parameter rows

The brief asked for at least ten aurora patterns, and flagged the obvious worry about a procedural or combinatorial version: harder to troubleshoot. Both halves of that are correct, and they are separable.

What shipped is **one** shader program, **one** BufferGeometry, and a table of sixteen **named parameter rows**. Every form is the same twenty-six numbers with different values. There is no per-pattern code path, no shader permutation, no branch that only some patterns take, and therefore exactly one program to debug. Everything that makes a band a *drapery* rather than a *SAR arc* lives in uniform arrays indexed by `aSlot` -- seven `vec4` arrays plus a `vec3` tint array -- which is legal because three.js compiles every non-Raw shader as `#version 300 es` and GLSL ES 3.0 allows dynamic indexing of uniform arrays. Switching the entire sky is a write of 341 floats.

The catalogue is the standard auroral morphology, going back to Stormer's classification in the 1910s -- **quiet arc, multiple arcs, rayed band, drapery, corona, breakup, omega band, diffuse patches, pulsating patches, picket fence, SAR arc, STEVE** -- plus the vortex family below. Fourteen of them get their colour from the altitude ramp like everything else. **SAR arc** and **STEVE** override it, and they are the two that are *not* electron precipitation at all (a SAR arc is thermal excitation of oxygen, STEVE is a hot plasma stream), so the override is a statement about physics rather than an escape hatch.

`P` (or the right A button in VR) cycles auto, then each named form in turn, then back to auto. The HUD names what is up and its weight. A form you cannot summon is a form you cannot judge, and several of these are rare on purpose.

#### The concurrency cap, and the floor that had to be reserved

Up to three forms overlay at a time, each with up to three bands, plus a reserved floor of two: `MAX_CONCURRENT x MAX_BANDS + FLOOR_BANDS == SLOTS` is asserted, so overflow is impossible by construction rather than by clamping.

Choosing *which* three is the hard part, and it is a continuity problem. Sorting by weight and keeping the top three **pops** -- when the third and fourth swap rank the sky loses a whole curtain in one frame, a step of 1.0. An **adaptive cut** (the weight of the first *rejected* form is a floor every accepted form fades against) is rank-invariant and therefore smooth across swaps, but the first version of it was *worse* in practice and the gate caught it: with forms saturated at 1.0, a fourth form rising from nothing did not displace the marginal one, it dimmed the entire sky at once -- a measured 0.43 drop across all three in a single step. What ships is the adaptive cut **with no special case**, plus slower channels. The subtle bug in between: skipping the crossfade when fewer than four forms were in play meant that the instant a fourth candidate crossed zero, the fade switched *on* for everybody -- a 0.21 to 0.08 step on a form that was not even the one changing. Removing the `cut > 0` special case removes it, because `cut = 0` then gives the same answer on both sides of that moment.

The continuity budget is arithmetic, not taste. The worst-case per-frame change in an output weight is roughly `3 x (rate of raw weight change) / CUT_WIDTH`, and a fade slower than about a second needs that under 0.02. That is *why* the pattern periods are hours rather than minutes: a fast channel and a hard cap cannot both be smooth, and the channel is the one that can give. Weights also carry the channel value as a small continuous term, so exact ties become measure-zero and rank changes become slow crossings rather than flips.

**The floor had to be reserved, not merely likely.** The original guarantee that the sky is never empty was to set the diffuse form's gate below zero so it was always a *candidate*. Being a candidate was never the same as being admitted. The soft top-K cut is `w * smoothstep((w - cut) / CUT_WIDTH)` where `cut` is the fourth-place weight -- permutation-symmetric and continuous, which is precisely what makes rank swaps invisible -- but when four candidates **tie**, `w ~= cut` for all of them and the smoothstep drives *every* output to zero. Growing the catalogue from twelve forms to sixteen made four-way ties common where they had been rare, and the gate measured **193 empty frames in 1.2 million**. The old guarantee was statistical, and statistics is not a guarantee. The fix is structural: `SLOTS` 9 -> 11, `FLOOR_BANDS = 2`, a `floor: true` flag on diffuse patches, and `composeAuto` pulls it out *before* the cut and appends it unconditionally afterward. It never competes for a slot, so it can never be squeezed out by a tie. Empty frames: **0**. It also freed a competitive slot, which fixed a second failure in the same run (15 of 16 forms occurring, rather than 16).

The gate sweeps two in-world weeks at **one-frame resolution** -- 1.2 million samples -- and reports the worst single-frame change in any form's weight. It is **0.0021**, i.e. a fade of about eight seconds end to end.

#### What makes a curtain read as a curtain rather than as a ribbon

Every one of these came from the same root: the mesh's own geometry being visible in the image.

- **Height must not be regular.** Every column reaching the same altitude makes the band a rectangle. Each column's top is now set by along-band noise (`ragged`) and by an **ovality** term that shortens the band toward its ends, so a band is a lens in silhouette rather than a rectangle with soft edges. The end taper is 30%. Together these are what make overlaid forms read as separate blobs of light rather than as stacked ribbons.
- **The top edge has to dissolve, not end.** The original deposition function was keyed on **absolute altitude** and was still non-zero at the top row of the mesh -- so it drew the top row, and a row of triangles is a straight line. It is keyed on **normalised height up the column** and multiplied by a term reaching exactly zero strictly inside the mesh. That is not physics, it is honesty about geometry: the top of an aurora has no edge at all. Normalising also means one deposition curve serves a 30 km picket fence and a 90 km SAR arc.
- **The bottom hem needs a per-column softness.** The hem's ramp width used to be a constant, so every column's bottom edge was equally sharp and the row of them read as a line -- the same failure as the top edge, one row down. `soft = mix(0.08, 0.26, fr)` ties it to the same noise `fr` that drives the hem streaks, so a column with a strong streak has a hard bottom and a column between streaks dissolves. One extra float in an existing varying, no extra noise call.
- **Individual columns fade out and back** (`flick`), and the lowest fifth of each column breaks into short vertical streaks that come and go independently of the band above it (`fringe`, two octaves of fast high-frequency noise, faded out higher up where the rays merge). A band whose every column is permanently lit reads as a painted object; a real one is continually rebuilt out of rays that live a few seconds each.
- **Folds scale with altitude.** `amp = B.z * (0.55 + (alt - 90.0) * 0.0072)`, which is physically the right sign -- the same transverse displacement of a flux tube spreads wider where the field is weaker -- and visually it is what turns a fold into a *fold*, because the bottom stays put while the top swings. Fold amplitudes across the catalogue run 28-66 km.

**Everything constant up a column lives in the vertex shader.** Column height, flicker, hem streaks, lobe mask, pulse phase -- all of them are properties of a *field line*, and a field line is a column. Computing them per fragment would be both slower and wrong. They arrive as varyings, which is why the fragment noise budget is still **two** evaluations despite everything above.

#### Presence: mostly absent, rarely blazing

`flick` shimmer works at **2 km and seconds**. A second envelope runs at **150 km and minutes**, so whole *sections* of a band come and go while the band itself persists:

```glsl
float mac = aurNoise( vec2( km * 0.0062, t * 0.028 ) ) * 0.62
          + aurNoise( vec2( km * 0.0210, t * 0.070 ) ) * 0.38;
float presence = mix( 1.0, 0.10 + 2.10 * pow( smoothstep( 0.20, 0.90, mac ), 2.0 ), F.w );
```

The `pow(..., 2.0)` is the whole idea in one operator: it makes the mean about **0.15** and the peak about **2.2**. Typical is barely visible; blazing happens, and it is rare. Deliberately separating the two scales by two orders of magnitude is what keeps them from reading as one noise -- a single envelope covering both would just look like static. Alpha gain is **0.80** to compensate for the lower mean, so an average moment is dim and a rare one clips toward white, which is what a substorm surge actually does. `breathe` is a per-form 0-1 depth knob on the envelope, so a SAR arc (the S is for *stable*) sits at 0.35 and a smoke plume at 1.0.

Curtains also have staggered activity thresholds, so a quiet night shows one arc and a storm brings several in -- the Akasofu substorm sequence (quiet arc, folds, curls and breakup, recovery) rather than a single global brightness knob.

#### The vortex family, and the one parameter that generates all of it

The literature calls these **auroral vortices**, and they come in a size taxonomy: **curls** at ~15 km, **folds** at tens of km, and **spirals** from 15 to 1300 km (typically 25-75 km), all winding counterclockwise around upward field-aligned currents in the northern hemisphere. "Flaming" is a separate thing -- a wave of brightness running *up* the field lines. ([Small-Scale Dynamic Aurora](https://pmc.ncbi.nlm.nih.gov/articles/PMC8550089/), [Zhou 2025 GRL](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2025GL114714).)

That taxonomy is the design: **four forms, one mechanism, different scales.** The mechanism is a single line in the vertex shader --

```glsl
float shear = F.z * ( alt - baseKm );
float f0 = aurFold( km + shear, t, amp, B.w, uActivity );
```

\-- which makes the sample point depend on altitude, so the fold pattern *leans* as it rises instead of standing straight up. Two things fall out of it that were not designed:

1. **A sheared curtain stops having a vertical edge.** Each altitude row samples a different part of the fold, so the silhouette twists and the thing reads as a volume rather than a sheet. That is the entire "smoke, not curtain" look, with no new geometry and no new noise call.
2. **Along-band drift becomes vertical motion.** With shear, a `drift` of `d` moves the pattern up the column at exactly `-d/shear`. So **flaming aurora** -- a wave running up the field lines -- is just a large shear plus a *negative* drift. The sign is not optional; a positive drift runs the waves downward, which looks like rain.

The four are **vapour spiral** (3 bands, shear 0.85-1.25, the big slow one), **auroral curls** (2 bands, shear ~1.0 at 2.6-3.1 Hz, the 15 km end), **flaming aurora** (2 bands, shear 2.2-2.5, drift -11 and -13), and **smoke plume** (2 bands, narrow spans of 24-30 deg, mostly invisible by design). None exceeds `ray > 0.5`, because a striated vortex reads as a curtain again; the gate asserts both the count and the softness.

Crucially, **no altitude term entered any noise lookup**. The shear moves the *sample coordinate along the band*, which is the axis the noise was always indexed on, so the field-alignment assertion still holds textually and unchanged.

#### The meander: the arc's course, measured as an angle

The folds are the curtain's own pleating. Where the arc *goes* is a separate quantity, and it is a fourth term in `aurFold` that is slower and longer than the three curtain octaves: rate `0.014` against `0.055/0.130/0.310`, wavelength scale `0.0034` against `0.0125/0.0410/0.1350`. Three properties make it a course rather than more noise.

It is **not multiplied by** `foldHz`, the per-form fold frequency. A form with tight folds should have tight folds on a wandering arc, not a tightly wandering arc.

Its amplitude is `MEANDER_FRAC * dist`, a **fraction of the band's own distance**, and its wavelength is divided by `mScale = 250 / dist`. Both make it an angular quantity: a band at 86 km and a band at 295 km swing the same number of degrees of sky over the same span of azimuth.

And it **replaces** the old first octave's `amp * 2.30` weighting rather than adding to it. That single substitution moved in both directions at once: the quiet arc's hem went from 0.72 degrees of swing to 2.3, because a quiet form's metric fold amplitude was small, and the catalogue's far radius dropped from 19,862 units to 17,492 of a 20,000-unit far plane, because a violent form's octave-1 amplitude had been +/-100 km. The forms that needed more got more and the form that was against the far plane got headroom, from one change, because the term being removed scaled with the wrong thing. `MEANDER_FRAC = 0.36` came out of a sweep over 0.10/0.16/0.22/0.30/0.36 against both of those numbers.

**Measuring "an S" took four metrics and three wrong ones.** The complaint was qualitative and the fix has to be checkable, so the gate walks each band's footprint and reduces the hem to numbers. The failures are the useful part.

- `swing`, peak-to-peak hem elevation in degrees, is the complaint made numeric.
- `bends` counts extrema of the hem **resampled into 16 buckets**. Counting every local extremum instead measures *jitter*: the quiet arc had 24 of them while swinging 0.7 degrees, which is the ruled-line-with-fuzz being scored as maximally sinuous.
- `path`, the swing of that same coarse resample, separates the arc's course from the curtain's texture.
- `flat` is the identical walk with `meander = 0`, so the mechanism under test can be isolated by differencing rather than inferred from a total.

Two checks then had to be narrowed rather than strengthened. "The meander is what is doing it" cannot be tested by differencing on a band already swinging 6 degrees from folds alone, because two overlapping waves do not add their extremes, so that check runs only on the bands whose folds leave the hem under 2 degrees (14 of 35). And "the straight forms stay straight" is asserted **per band against what the catalogue declares** (`meander < 0.5`) rather than globally, because STEVE's green picket-fence band sits at 103 km and folds 2.2 degrees on its own, with the meander contributing 0.0.

The measured catalogue, hem swing with the meander's own share in brackets:

| form | swing | bends | fold-backs |
| --- | --- | --- | --- |
| quiet arc | 2.3 (2.2) | 3.0 | 0.0 |
| multiple arcs | 2.8 (2.7) | 3.7 | 0.3 |
| rayed band | 3.4 (3.1) | 5.2 | 4.3 |
| drapery | 4.4 (3.9) | 5.6 | 13.3 |
| corona | 6.6 (5.7) | 5.0 | 5.4 |
| breakup | 8.3 (6.6) | 6.2 | 59.3 |
| omega band | 4.4 (4.2) | 4.6 | 1.0 |
| diffuse patches (the always-on floor form) | 2.9 (2.7) | 3.1 | 0.0 |
| pulsating patches | 3.0 (2.8) | 3.3 | 0.0 |
| picket fence | 3.2 (3.0) | 4.1 | 1.1 |
| SAR arc (declared straight) | 1.1 (0.9) | 5.8 | 0.0 |
| STEVE (declared straight) | 2.2 (1.9) | 6.5 | 0.0 |
| vapour spiral | 3.5 (3.3) | 2.3 | 0.1 |
| auroral curls | 4.9 (3.9) | 6.1 | 69.1 |
| flaming aurora | 4.0 (3.4) | 6.0 | 20.7 |
| smoke plume (24-30 deg span, not an arc) | 1.1 (1.1) | 1.1 | 0.0 |

The gate's floors are 2 degrees of swing and 2 bends for anything the catalogue calls an arc, 1 degree of meander contribution for the fold-quiet bands, 0.5 degrees maximum for the declared-straight ones, and 35,640 triangles unchanged.

#### Colour per form, from two knobs

Two per-form floats, both 0-1. `pale` slides both endpoints of the ramp together: 0 is the classic OI 557.7 green over N2+ violet, 1 is a pale alien mint over electric blue (which is the real N2+ 427.8 nm line, so this is still the spectroscopy table, just weighted differently). `crown` scales how much 630.0 nm magenta sits above ~180 km.

```glsl
vec3 violet = mix( vec3( 0.62, 0.18, 0.72 ), vec3( 0.18, 0.60, 1.00 ), vCol.x );
vec3 green  = mix( vec3( 0.14, 1.00, 0.44 ), vec3( 0.56, 1.00, 0.84 ), vCol.x );
vec3 col = mix( violet, green, smoothstep( 92.0, 111.0, alt ) );
col = mix( col, vec3( 1.00, 0.20, 0.46 ),
           clamp( smoothstep( 155.0, 235.0, alt ) * 0.85 * vCol.y, 0.0, 0.95 ) );
```

All sixteen forms have a distinct `(pale, crown, tintAmt)` triple, and the gate requires at least eight distinct ones so a future retune cannot quietly collapse them back to one.

#### The rest of the shader, and the fill-rate budget

- **Edge-on brightening.** A curtain seen edge-on is far brighter than one seen face-on, because you are looking along much more emitting gas. The fold displacement already gives an analytic surface normal (one extra noise evaluation via finite difference in the *vertex* shader), so `1/|dot(view, normal)|` clamped to 4.2x gives the effect for free and it self-animates as the folds move. This is the single highest-value line in the file.
- **Altitude deposition.** A sharp lower edge (electrons stop where the air thickens) and a long exponential tail upward, which is why real auroras have a knife-edge bottom and a soft top.
- **Ray crispness falls with altitude.** Striations are sharp in the green band and washed out in the red, because the red-emitting state is long-lived enough for the gas to move before it radiates.
- **Two noise evaluations** in the fragment shader against a budget of three. "Keep the fragment shader short" is the one budget in this file that is enforced numerically.
- **Cost when the sun is up is nothing at all.** Stars and aurora both set `visible = false` when their fade reaches zero. The gate asserts it.

#### Depth, without any sorting

Additive materials land in three.js's transparent pass, which runs *after* the opaque pass has already filled the depth buffer. So `depthTest: true, depthWrite: false` gives correct mountain occlusion for both the aurora and the stars with no `renderOrder` games at all. Across all sixteen catalogued forms the geometry reaches 17,492 units at full fold stretch inside a 20,000-unit far plane and comes no nearer than 5,317 units, and the highest line of sight is **72.6 deg** (corona, which is *supposed* to be overhead -- that is what a corona is). The gate fences that at 80, which is the other end of the same argument that pushed the bands outward: colour is a function of altitude, so lowering a band by trimming `alt1` would not lower it, it would delete its red crown. Only the *geometry of where you stand relative to the altitudes* is free, so the transform holds `alt0` fixed and pushes `dist` outward instead. Bottom elevations run 19-49 deg; band distances 86-295 km; `MAX_RADIUS_KM = 333`.

#### What was reverted, and where the boundary is

**"Before X" means the last state that was seen, not the last commit before X.** One release landed with a duplicate `mScale` in it, so it never linked and never drew a pixel; the next round then re-tuned altitudes and extinction on top of a mesh nobody had ever looked at. Both rounds are therefore work whose *appearance* was never in evidence, and `src/aurora.js` and `src/aurora-patterns.js` were reverted wholesale rather than patched forward.

Out of the tree, and recorded in `design/history/aurora-rounds-4-6.md`: the 14,000-unit shell, the `d^2 / 2R` curvature drop, the `swoop`, the re-siting to 94-1,180 km, `MAX_RADIUS_KM = 1,600`, the narrowed extinction window, the `twist` and `flame` terms, and the 12-form catalogue. What survived is what had been committed before the round that broke -- the tangential footprint `tng * f0.y`, the quarter-wave trochoid offset, `curl`, and the gate's JS port of the noise -- plus the meander above, which is the one piece of the shell's thinking worth keeping and is kept without the shell that motivated it.

#### What the gate can see, and what it cannot

**Nothing in** `npm run check` **links a shader.** The gate runs in node; everything it knows about the GLSL it knows from reading the source as text, so the entire class of "this does not compile" is invisible to it -- and that class is fatal to every other check in the file at once. That is exactly how the unlinkable release above survived a full gate run and a round of retuning on top of it. `float mScale = 250.0 / A.x;` was declared twice in the same scope of `main()`, GLSL ES rejects a same-scope redeclaration, the program never linked, and the mesh drew nothing at every hour under every pattern. The error was sitting in the browser console the whole time.

Worse, the assertion guarding that very feature was reporting green *because* of the bug:

```js
check(/float mScale = 250\.0 \/ A\.x;/.test(auroraSrc), 'and that wave is measured in degrees of sky ...')
```

**A presence check cannot see a duplicate.** Two copies satisfied it twice over. Written as a count rather than a match, it would have failed immediately.

What stands there now is a **same-scope redeclaration scan**: pull every template literal containing a `main()` out of the shader-bearing files, strip comments, keep the first branch of each preprocessor conditional, walk the braces with one scope Set per block, and report any name declared twice in the same Set. Not a compiler and not trying to be -- it catches the one error class that is invisible to every other check here, and it was verified the only way a check like this can be, by putting the bug back and watching it fail. The real fix is a headless GL context (`gl` or a Playwright page) that links each program once and fails on the info log; a type mismatch, a missing varying, an undeclared identifier or a wrong argument count would all still pass everything here and still draw nothing.

Also: a GLSL comment inside a JS template literal must not contain a backtick. Five of them did, and the resulting `SyntaxError` pointed at a line 100 lines away from any of them.

#### Where it stops

Judged in the world: *a bunch of wiggling semi-animating polygons drifting around in the sky, limited and fake relative to a real aurora.*

The ceiling is **topological**, not a matter of tuning. A curtain can fold and it can meander, but it cannot BRANCH, it cannot merge with the curtain beside it, and it cannot be anywhere the mesh is not. The sky ends up with the topology of the geometry that was authored for it, and no amount of noise on a ribbon changes that. Everything below is the answer to it.

### The replacement: the raymarch lab at `/test-aurora`

`src/aurora-lab/*` plus `src/test-aurora-main.js` and `test-aurora.html`, gated by `scripts/check-aurora-lab.mjs`. A separate page rather than a mode inside `v2.html`, for the reason the grass bench is separate: what it needs is an empty sky over a nominal skyline and seventy sliders, and putting that behind a terrain load, a document fetch and a walk to a vantage point would mean paying all three every time you want to see what one exponent does. It is also the only page with nothing in it but sky, which is what makes it honest about the shader's cost.

**Nothing here ships yet.** The lab is where the replacement gets designed; promoting one of its algorithms into `src/aurora.js` is the open work.

#### A field, not a mesh

The march walks ~40 altitude slices through a **plan-space scalar field**. A field is defined everywhere, so channels split, rejoin, thin out to nothing and knot where two families cross, and none of it costs a vertex. That is the branching the polygon version is structurally incapable of, and it is the whole reason the lab exists.

Three more things the march gets for free rather than faking:

- **Vertical structure.** `auroraField` takes a plan position and no altitude, so a given field line has the same field value all the way up, while different altitudes along one view ray land on different plan positions. That is what makes a curtain look like a curtain -- and it is the same one-character hazard as before: an altitude term anywhere in the ray, flow or shimmer coordinates unmakes it.
- **Edge-on brightening.** A ray that skims along a channel simply passes through more of it and accumulates more. No surface normal, no `1/|cos|`, no clamp.
- **Perspective.** Channels converge toward the horizon and splay overhead because they are being integrated in a real plan rather than painted on a wall.

#### The contract

An algorithm supplies one function and nothing else:

```glsl
vec4 auroraField( vec2 p, float t )
```

`p` is the horizontal position in the aurora's plan in field units (kilometres x `u_fieldScale`), the eye at the origin, -z north. It returns `.x` raw depth inside the emitting sheet (0-1, deliberately **not** a final brightness), `.y` a coordinate running ALONG the channel, `.z` a channel id constant across a channel's width and different between neighbours, `.w` a local gate. Return 0.0 for the id and the whole sky pulses in unison, which reads as a fault in the shader rather than as weather.

#### Four algorithms

Listed in dropdown order, which is `ALGORITHMS` in `algorithms.js`.

- **`leyline`** -- contours of a domain-warped potential field, `phi = (warped y) * frequency + (a second noise) * bend`, rendered by `tri(phi)` so the entire family is one evaluation at a cost independent of channel count, with `floor(phi + 0.5)` falling out as the id. Contours **never cross** (a point has one value, and auroral arcs never cross either), **run parallel without being parallel**, **crowd and thin** where the gradient steepens and flattens, and **split at saddle points**. That last one is the branching, and it is most of why the lab exists.
- **`sine`** -- the same contour family with **every noise lookup replaced by trigonometry**. `phi` is built from a rotating shear plus two nested stages of sine-sum domain warp instead of from fractal gradient noise, so it needs only the `util` chunk and does **zero** noise lookups. The nesting is the trick: a sine sum has a line spectrum, which is exactly what "regular" looks like, but `sin(x + A sin(y))` is frequency modulation and its Bessel sidebands are broadband for the price of three more sines. Hand-counted at about **105 arithmetic instructions plus 14 `sin` per march step** against leyline's ~2,000, so roughly **17x cheaper**. Two caveats, both stated in the file's header: weighting a `sin` at 4x an ALU op (special-function unit, quarter rate) puts a step at ~161 rather than 105, so the cheapness holds on instruction count and **not** under a pessimistic transcendental weight; and there is **no fractal detail below the second warp's scale**, so a channel edge is smooth in a way a real curtain is not. It renders as broad soft sheets with genuine dark voids -- noticeably wider and softer than leyline, and lacking leyline's fine vertical striations.
- **`weave`** -- two ley-line families read off **one shared warp** at an angle, with one drifting past the other. Sharing the warp is the point: two independent fields read as two separate auroras in the same sky and the eye separates them instantly, whereas two families off one warp pinch where it pinches and swing where it swings. The knots where they coincide are genuine caustics, the same mechanism as a swimming-pool floor -- and the knots race along the lattice far faster than the drift itself. `wvKnot` mixes `smax(a, b)` (the union: a lattice) against `sqrt(a * b)` (the intersection: isolated blazing lozenges); nearly every good setting is in between. This is the brief's "shimmering overlaid intersectional shader similar to what water surfaces have".
- **`filament`** -- iterated triangle-wave folding. The triangle wave's derivative flips sign at every fold, so each iteration folds the plane back on itself and lays a **crease**; fBm is a sum of smooth functions and cannot produce a crease no matter how hard it is stirred, which is why turning the ley-line warp up gives marbling rather than filaments. Brightness comes from a reciprocal rather than a threshold, so the bright curve is as thin as float precision allows with a long glow tail instead of an edge, and `filStretch` squashes one plan axis before folding so the creases come out long. This is the substorm-breakup look. Its honest limitation: folding has no notion of a channel, so `id` is a crude band index and per-channel gating is much less convincing here than under ley lines.

#### Everything downstream of the field is shared

Thresholding, sharpening, the scatter skirt, altitude deposition, the auroral belt, vertical rays, along-channel flow, the caustic shimmer, colour, exposure and march quality all live in `SHARED_GROUPS` and are applied once by the frame. The split is deliberate and it is worth defending: **the lab exists to COMPARE algorithms, and you cannot compare two skies whose knobs are not the same knobs.** Let each algorithm own its own sharpness and its own colour and every difference you see might be the algorithm or might be that one of them happens to be tuned brighter. An algorithm may `override` a shared param's *starting value* -- filaments want a different sharpness than ley lines do -- without owning it.

Two of the shared terms are worth naming because they are what separate a procedural sky from a photographed one. The **belt** cuts the aurora to a band in *plan* space rather than in view space, so turning around genuinely puts it behind you and walking north makes it climb; without it there is glow in every direction, which is the loudest tell there is. And the **scatter skirt** is a second, far wider exponential profile on the *same* distance field, costing one `exp` and no extra field evaluation; take it to zero and the channels look cut out with scissors.

#### What a pixel costs, measured against this project's own water

One `leyline` march step is about **21 noise lookups**: 12 for the two-stage domain warp (`warp2` is two stages of two `gfbm2` calls at three octaves each), 3 for the ley bend's `gfbm2`, and one each for the channel gate, the patchiness, the vertical rays and the flow, plus two for the caustic pair. At the default 40 steps that is **~840 noise evaluations per pixel**, which is what makes this a volume integral rather than a surface shade.

The stated budget is "no more than about 4x a water surface", so the unit has to be a number off this repo rather than a generic estimate. `waveNormal` in `src/water.js` (`WAVE_LAYERS` at line 222, unrolled through the generated `layerTerm`) is four `wNoise` calls; each is four `wHashDir` lookups at two transcendentals apiece plus an **analytic** derivative, so roughly 140 ops each and about **660** for the four -- and the two detail layers sit behind the coherent `near > 0.004` branch, so the far half of a lake pays about half of it. On top of that: `skyRadiance`, `wlBlocked`, one cubemap fetch, two `glint` pows and a Fresnel pow. **One water pixel is therefore about 6-9 `gnoise2`-equivalents, and 4x water is 24-36 noise lookups per screen pixel.** Against that ceiling, charging every step the full 21: the `lowres` preset (the reference's parameters at 64 steps in a sixth-size buffer) is 21 x 64 / 36 = **~37 per screen pixel, about 4.2x water**, and `fast` at 20 steps in its own quarter-size buffer is ~26, about 3x. These are hand counts off the GLSL, not a profile, and the `fast` figure is the pessimistic one -- its own `warpStages` 1 and patchiness 0 take the real per-step count nearer 14.

#### Drawing the aurora small, which is the lever everything else now sits under

`src/aurora-lab/lowres.js`, class `LowResAurora`, driven by two params in "March quality": `lowRes` (divisor 1-10, and **1 is a true bypass with no target allocated at all**, so the A/B is against the truth rather than between two lossy paths) and `lowBlur` (tent radius in **texels of the low-res buffer**, so the softening stays put as the divisor moves instead of needing a retune every time).

The shader costs `fragments x steps x lookups`. Every other knob in the lab pulls on the last two factors and every one of them changes the picture; the fragment count is the only factor that can be cut without changing what is drawn, and it is **quadratic**. Pass 1 renders the sector into a `WebGLRenderTarget` a divisor smaller on each axis, in a scene containing nothing else. Pass 2 draws the **same geometry again** in the main scene with a cheap material that samples that target in screen space -- `uv = (gl_FragCoord.xy - u_viewport.xy) / u_viewport.zw`, exact rather than a reprojection because both passes used the same camera -- through a 3x3 tent.

**Compositing through the mesh rather than through a fullscreen quad is the load-bearing choice, and it is about the mountains.** A fullscreen triangle has no depth, so it would paint the aurora straight over the skyline and the horizon would stop existing. The same sector at the same world position with the same depth state keeps the one real occlusion in this scene, and it also means **the ridge silhouette stays resolved at NATIVE resolution at every divisor** -- only the sky inside it is sampled coarsely. Both meshes share `screen.geometry` by reference so they cannot disagree about where the sector is by even a vertex.

**The upsample is also the fix for the speckle, which is the bigger half.** Rendering small makes each output pixel the mean of several independent estimates of the same integral -- the bilinear fetch averages four, the tent averages a neighbourhood of them -- and that is the definition of reducing an estimator's variance. Measured over one identical frame at several buffer sizes, on a 480x300 SwiftShader canvas: speckle per thousand bright pixels, grain (mean absolute green difference to the right-hand neighbour over lit pixels), drift (mean absolute green difference from the full-res reference frame), and fill rate.

| buffer | speckle | grain | drift | fill |
| --- | --- | --- | --- | --- |
| 1/1 | 0.0 | 0.73 | 5.89 | 1.0000 |
| 1/2 | 0.0 | 0.68 | 5.72 | 0.2500 |
| 1/4 | 0.0 | 0.59 | 5.70 | 0.0625 |
| 1/6 | 0.0 | 0.50 | 5.72 | 0.0278 |
| 1/10 | 0.0 | 0.41 | 5.70 | 0.0100 |

Speckle is **zero at every divisor** and grain **improves** as the buffer shrinks. Drift barely moves from 1/1 to 1/10, so the whole 5.7 is the `fast` preset's parameter cuts and none of it is the resolution: **downsampling costs essentially no structure.**

**What governs the divisor is the buffer's ABSOLUTE width, not the ratio.** A sixth of the 480-wide probe canvas is 80 px and loses the fine ray striations; a sixth of a 2560-wide display is 427 px and does not. Keep the low-res buffer somewhere around **250-400 px wide** and set the divisor from that -- which also means the probe's own 1/10 row is *pessimistic* relative to a real display.

The target is `RGBA16F` holding **linear** radiance, because three forces `linearToOutputTexel` to a passthrough for any non-XR render target; the composite therefore has to do the sRGB encode itself, and the class drives `screen.mesh.visible` so that one material is never drawn to two destinations in one frame. Both traps, and the half-float and bandwidth arithmetic behind them, are argued out in the file's header.

Under all of that sit the shader-side levers, which are now the second thing to reach for rather than the first:

- **`warpStages`** (1 or 2, in "March quality") is the most expensive single number *inside* the march. `warp2` takes the count as an argument and returns after the first stage below 1.5, which removes six gradient-noise lookups per step -- close to 30% of the shader. One stage still bends the channels, because bending them is what the first stage does; what the second buys is the curdled marbling *inside* a bend, and that is a visible loss where a smaller buffer is not.
- **Every optional term is gated on its own amount rather than mixed in afterwards.** The vertical rays, the flow, the caustic pair and the per-step belt in `frame.js`, and the bend, the channel gate and the patchiness in `leyline.js`, each sit behind a test on their own uniform. Computing them unconditionally and folding them in with a `mix` meant a slider at zero removed the *effect* and kept the *cost*, which makes the panel lie about performance and means a cheap preset is not actually cheap. The tests are on uniforms, so every fragment in the draw takes the same side: no warp divergence, and a disabled term costs the compare rather than the body. The rays, the flow and the caustic pair are **four** value-noise lookups a step out of the twenty-one, so switching all three off is a fifth of a leyline step; the belt gate saves an `exp` and a `pow` rather than a lookup.
- **An early-out is only worth its ALU if the bound it computes can reach the threshold it is tested against.** A per-ray belt cull culled exactly 0% of 130k sky directions, because the belt term `mix(1, exp(-d), u_beltAmt)` has a floor of `1 - u_beltAmt`: at the default 0.85 it bottoms out at 0.15 however far the ray is from the oval, so no distance threshold can ever call the ray dark. The belt dims the far sky to fifteen percent, it does not switch it off. What does drop those rays is the screen's shape, under "Layout" below -- a change of geometry rather than of arithmetic, and a per-ray test cannot beat not having the fragment.

#### Colour

`emissionRamp` takes a normalised height and nothing else, for the reason in "What an aurora actually is" above. Its two knobs, `pale` and `crown`, are **ratios between the three emission lines** rather than free hue choices, which is what keeps the whole reachable range plausible. Transitions are fractions of whatever altitude range is currently set rather than kilometres, because the range is two draggable numbers and a colour written in km would silently drift out of it; over the default 90-260 km, `hemBand` 0.12 puts the violet-to-green crossover at 110 km and `crownStart` 0.42 starts the red at 161 km.

Beside it, and **declared as invented**, is `neonRamp`: an Inigo Quilez cosine palette driven by the along-channel coordinate, so hue travels down a channel instead of sitting at an altitude. The two are exposed as a **mix, not a switch**, because the interesting sky is between them -- a physically-coloured curtain with a hue that breathes along its length reads as a real aurora doing something impossible, where full neon reads as a screensaver and full physics reads as the photograph everyone has already seen.

#### Three implementation details that cost real time to arrive at

These are settled. Do not re-litigate them.

1. **The dither is STATIC.** Integrating an emissive volume in 24 steps leaves 24 concentric shells across the sky. Offsetting each fragment's sample positions by `hash21(gl_FragCoord.xy)` converts that coherent shell into incoherent per-pixel noise the eye integrates away, and it buys roughly **4x the step count for one hash**. There is **no time term** in it: time makes it a film grain that crawls, which is worse than the banding on a still image and much worse in a headset, where the two eyes get uncorrelated grain and the sky fizzes.

   What that trade leaves behind is the reported **"littered with black pixels", and it is Monte Carlo variance rather than a bug**. There is no NaN path: every `pow()` base in the march is a `sat()`, a `smoothstep` or a `1 - abs()` of two 0-1 values, and `vnoise2` is a `mix` of `hash21` outputs so it cannot leave 0-1. What actually happens is that the dither makes each pixel an N-sample estimate of the altitude integral, and where a channel is thin one pixel lands inside it three times while its neighbour lands inside it once -- which reads as **dark speckle on bright ground** rather than as symmetric noise. Counted as pixels below half the mean of their own eight neighbours, per thousand bright pixels: **0.0 at 40 steps, 0.4 at 20, 3.5 at 16, 17.7 at 12.** It quadruples per halving of the step count, and setting `dither` to 0 takes it to 0.0 at every step count, which is the proof that it is variance. The fix is the low-res buffer above, which averages several estimates into each output pixel; there is nothing to clamp.
2. **Riemann `dk` weighting.** `u_stepBias` packs samples toward the hem where the deposition curve has its knife edge, so each sample is weighted by the slice of the altitude range it actually stands for. The consequence is that **step count and step bias change the QUALITY of the sky and not its brightness** -- tune at 24 steps, judge at 80, touch nothing else. Without it every drag of the quality slider needs a compensating drag of the gain and you can no longer tell whether the sky got better or just brighter.
3. **The global weather field is sampled ONCE PER RAY, not per step.** A ~40x saving, and also more correct: sharpness is a property of a region of sky, not of a point along a ray, and sampling it per step makes one curtain change its own sharpness halfway up. `u_gRefKm` is which slice of sky that one sample is taken from. Each of the four weather modulations (dim, fuzz, sharpen, scatter) carries its own amount, precisely so three of them can be taken to zero to find out which one is doing the thing you are looking at.

A fourth, smaller: the altitude-to-distance divisor is floored at 0.035 rather than zero. At full perspective a ray a hundredth of a degree above the horizon would otherwise sample the field ten thousand kilometres out, where float32 has lost enough mantissa that the hash lattice goes visibly blocky -- a band of coarse noise sitting exactly on the skyline, which reads as a bug in the mountains rather than in the sky.

#### The param schema is the single source of truth

A param is one object -- `{ key, label, hint, type, min, max, step, value, uniform }` -- and it is simultaneously a row in the sidebar, a uniform declaration in the shader, a field in the tuning JSON, and the default that `reset` restores. There is deliberately no second list anywhere.

The uniform block is **generated** from the schema (uniform name is always `u_` + key), which closes a specific hole. Hand-written uniforms and hand-written sliders are two lists that must agree, and when they disagree the symptom is a slider that does nothing -- no error, no console line, just a control writing to a name the shader never declared. Generated, a param that exists has a uniform, and GLSL referencing a uniform no param declares is an outright compile error naming the missing identifier. `uniform: false` marks the params that drive JavaScript instead (time scale, FOV, render scale, stars, mountains), declared here anyway so there is one persistence path, one reset and one preset format.

There are seventy-odd knobs per algorithm and that is the point: this is a tuning rig, not a settings screen. What keeps seventy usable is that every param carries a `hint` saying what it does and what it looks like when it is wrong. The shipped aurora will read a handful of preset blobs out of this and expose none of them.

**Three presets are checked in** rather than saved to localStorage (`src/aurora-lab/presets.js`), because a tuning you cannot get back is not a reference and localStorage does not survive a cleared profile or anybody else's machine. None of them can be overwritten or deleted from the panel, which is the point of a builtin, and that file's trade list is the authority on what each one gives up.

- **`reference-v1`** is the pinned pre-optimisation sky -- "looks fantastic, just needs 200x optimization", at ~15 fps on an Apple silicon laptop at full render scale -- and it exists so that everything done to the shader afterwards can be judged against it: if the sky still looks like that and costs less, the change was free, and if it does not, the trade needs stating out loud.
- **`fast`** is written as a *delta* on the reference so the two cannot drift apart on a knob nobody meant to change: 20 steps instead of 40, one warp stage instead of two, patchiness off, `leyWarp` and `sharp` nudged up because one stage of warp displaces less and a smoother field needs a harder threshold, plus `lowRes` 4 and `resScale` 0.7 -- which compose rather than compete, since the divisor is applied to drawing-buffer pixels, so the aurora ends up at 0.7/4 of native on each axis, about a thirty-third of the fragments, while the stars and the ridge stay at 0.7. Every one of its *shader* cuts costs something visible, because it was built before the offscreen buffer existed and so every saving in it had to come out of the march.
- **`lowres`** is what the measurement actually recommends, and it inverts that arithmetic. It is the pinned sky **untouched** -- two warp stages, patchiness on, every optional term where the reference put it -- with the step count raised to **64** and the whole thing drawn into a **sixth-size** buffer. Measured against the reference frame: speckle 0.0, grain **0.31** against the reference's own 0.67, drift **0.80** levels of green, cost **0.044**. Cleaner than the original on both artefact measures, 0.8 levels away from it in structure, at **4.4% of its cost**. Once fill rate is that cheap the right move is to spend it back on the step count, which *removes* the artefact rather than hiding it.

#### Layout

```
test-aurora.html                    route
src/test-aurora-main.js             the page: camera, clock, stars, panel wiring
src/aurora-lab/glsl/noise.js        hash, value, gradient, fbm, warp, filament -- one GLSL string each
src/aurora-lab/glsl/palette.js      emissionRamp (physics) + neonRamp (declared invention)
src/aurora-lab/glsl/frame.js        the vertex shader, the raymarch, main() -- shared by every algorithm
src/aurora-lab/algo/leyline.js      contours of a warped potential field
src/aurora-lab/algo/sine.js         the same family out of pure trigonometry, no noise at all
src/aurora-lab/algo/weave.js        two families on one warp; the knots are caustics
src/aurora-lab/algo/filament.js     iterated triangle-wave folding
src/aurora-lab/algorithms.js        the param schema and the registry
src/aurora-lab/presets.js           the three checked-in tunings: reference-v1, fast, lowres
src/aurora-lab/lowres.js            the offscreen low-res pass and the composite that puts it back
src/aurora-lab/screen.js            assembles the shader, owns the sector mesh and the uniforms
src/aurora-lab/backdrop.js          procedural mountain silhouette, 3 layers, one draw call
src/aurora-lab/ui/sidebar.js        builds itself from the schema; imports nothing
```

The shader is **assembled** rather than written: four algorithms times one shared frame is four shaders, and hand-maintaining four copies of a hundred-line raymarch means fixing every bug four times and, in practice, fixing it three times and forgetting the fourth. Every chunk carries its own include guard, so an algorithm's `needs` list can be over-broad at no cost.

The screen is a **world-locked northern sector, not a camera-facing quad**. What licenses either shape is what the shader does with the geometry: `main()` uses the fragment's world position for exactly one thing -- subtracting the eye to recover a ray direction -- and then throws it away, so the mesh is a window rather than a surface and any surface covering the same set of directions produces byte-identical pixels. A billboard covers the directions you are looking at; a sector covers the directions the aurora is in, and the second set is much smaller -- **48.3% of the sky above the horizon**, measured over a 240x240 direction grid. Since the belt sits to the north, a camera-following quad spends most of its fragments marching rays the belt term dims to a sixth, at full price, because a fragment that integrates to almost nothing costs exactly what a bright one does. Cutting the mesh down deletes them at the rasteriser, which is free.

So it is a partial `SphereGeometry`: 200 degrees of azimuth centred on north (a hard 180 would put its vertical edges due east and west, which are headings you look along, and `u_edgeFade` needs sky on the far side of the belt to fade across), elevation from -6 to +78 degrees (the march's own horizon cut should be what ends the sky, and the last twelve degrees to the zenith are the most expensive part of a sphere's tessellation with no aurora ever in them), radius 5,200 -- beyond the mountains at 1,500 so they occlude it through the depth test, well inside the stars at 15,000. It is built once in the constructor; `update()` only recentres it on the camera, and there is no FOV to track because it is not sized to the view any more. `frustumCulled` is true, so facing south drops the draw entirely and the aurora costs nothing at all, which the billboard could never do because it was always in view. Additive, `depthWrite: false`, `depthTest: true`, `renderOrder = -800`, same reasoning as the shipped aurora.

The **backdrop is not geometry**. The lab's camera rotates and never translates, and a viewer that cannot translate cannot resolve parallax, which is the only thing a real mesh of mountains would buy. So the skyline is a 1D function of compass bearing evaluated in the fragment shader -- ridged multifractal, three distance layers at apex heights of 12 / 8 / 5 degrees measured off the reference frames in `mountain_silhouettes/` -- carried on a lat-band sphere cap of radius 1,500 that runs from +75 deg elevation to the nadir and **closes** there. A cylinder was the alternative and loses on one point: it is open at the bottom, so "tall enough" depends on how far the camera can pitch and how wide the FOV goes, and guessing low shows sky underneath the mountains. There is no hole in the cap, so no FOV and no pitch can find one. It must write depth, because the stars and the aurora both draw additively with `depthWrite: false` and rely on the buffer already being filled.

#### What is verified, and what is not

`node scripts/check-aurora-lab.mjs` passes and `npx vite build` passes. `aurora-probe.html` links **every** algorithm including `sine` on a real WebGL2 context under SwiftShader, captures a frame of each, and exercises `LowResAurora` at divisors 1, 2, 4, 6 and 10 -- counting lit pixels rather than only watching for a compile error, because a wrong viewport rect or a stale material gives a clean compile and an empty sky. It also carries a regression for **`AuroraScreen.setAlgorithm` disposing the material out from under a captured reference**, which was a real bug the low-res work found: the symptom was a black sector after an algorithm switch with nothing in the console, and the fix is re-borrowing the material every frame.

Nothing below has been checked anywhere.

- **The lab has never been loaded in a real browser interactively**, and **no frame rate has been read off a counter on the optimised sky on any device**. Every cost figure above is a lookup count or a fill-rate ratio.
- **Nothing has run on a Quest 2.**
- **`LowResAurora` does not handle WebXR, explicitly.** Pass 2's `gl_FragCoord` runs across a side-by-side framebuffer while the target holds one eye, so the right eye would sample the wrong half. The class's viewport uniform is a `vec4` rect precisely so that the fix -- one target and one viewport per eye -- is a setter call rather than a shader rewrite.
- **Temporal shimmer is predicted and unmeasured.** A screen-space low-res buffer slides across world-locked content, so turning the head should make the sky crawl. That is expected to bite before spatial softness does, with a practical ceiling somewhere around divisor 3-4 in a headset even where the frame budget would allow 8.
- **Which algorithm wins.** All four are built and tunable against the same knobs, which was the whole point of the split. `leyline` and `weave` have been looked at once on a desktop and both read as gorgeous; `filament` was judged to be nothing; `sine` has only been seen as a probe capture. None of it has been promoted into `src/aurora.js`.

See TASKS.md for the order that work goes in.

### The third answer: traced contours as geometry, at `/test-aurora-v2`

`src/aurora-cards/*` plus `src/test-aurora-v2-main.js` and `test-aurora-v2.html`, gated by `scripts/check-aurora-cards.mjs`. It exists because the two ceilings above are opposite and neither is a tuning problem: the polygon aurora is cheap and **topologically incapable** of branching, and the raymarch branches beautifully and costs about 200x its budget. This technique takes the raymarch's field and the polygon version's cost model, by **finding the contours once on the CPU and drawing them as geometry**.

The move that makes it work: the raymarch is expensive because every pixel has to SEARCH for the channel along its ray, and a contour of a scalar field can be found ONCE, on the CPU, in a plan the eye never re-derives. Once the channel's position is a vertex buffer, the fragment shader has nothing left to look for.

#### Marching squares, not a walker

`src/aurora-cards/field.js` is a straight JS port of the ley-line potential (`hash21`, `vnoise2`, `gnoise2`, `gfbm2`, `warp2`, `phi`), and `trace.js` runs marching squares over it on a `gridN` x `gridN` lattice.

A walker integrating along the gradient perpendicular was the obvious alternative and it is the wrong tool for exactly the reason the whole technique exists: at a saddle the walker must PICK a branch and silently discards the other, so a walker reproduces the polygon aurora's ceiling in a different notation. Marching squares visits every cell and therefore finds the branches because they are there. What it costs is a staircase at grid resolution, removed by `smoothPasses` of a [0.25, 0.5, 0.25] filter.

Cases 5 and 10 are the ambiguous saddles and are resolved by the cell-centre average. A mis-resolved saddle is invisible in a still frame and obvious in motion, because two channels trade halves and the join flickers as the field morphs past the ambiguity. Segments are linked by **edge key**, not by matching positions: both cells sharing an edge compute the crossing from the same inputs but not necessarily the same rounding, and the epsilon that would be right depends on the field's local gradient, which varies across the sky.

Measured at the shipped defaults: **30 components across 10 contour levels, 15 of them closed loops**, 24,222 km of channel, traced in 50-100 ms. A ribbon mesh cannot produce a closed ring at all, so those 15 are the direct evidence that the topological ceiling is gone rather than raised.

#### A vertical card is the correct impostor for a ray, not a compromise

`ribbon.js` records the standing objection to any geometric aurora: a card disappears edge-on. It does not apply here, and the reason is physics rather than tuning. A ray is a magnetic field line, which is to say a radially symmetric column of gas, so it looks the same from every azimuth. A card that yaws about the **vertical** can therefore never be edge-on, and the billboard is exact rather than an approximation of a surface.

It also gets the edge-on brightening the polygon aurora had to fake. N columns along the line of sight are N real composites through one pixel, so `src/aurora.js`'s `grazing = clamp(1/max(abs(dot(view,nrm)),0.16), 1, 4.2)` has no counterpart here. There is nothing to clamp.

**And the card is flat.** It was subdivided vertically for a while, for exactly one reason: so that a sideways fold and lean displacement could CURVE as the column climbed. That displacement is gone, because bending a card worked against the illusion it was serving. The sheet here is **assembled out of columns**, and a bent column stops matching its neighbours, so the fold that was meant to read as drapery instead made every card individually visible. Drapery comes from where the contour runs on the ground, which is the trace's job and which it was already doing. With it gone nothing varies horizontally with height, so one quad is exact rather than an approximation -- **four vertices and two triangles, dead straight, yawing about world up** -- and the triangle count fell. It also means there is no altitude-dependent horizontal displacement left anywhere in the shader, so the vertical-structure rule below is now structural rather than merely observed.

#### The vertex/fragment split is physics, not optimisation

Every auroral structure is vertical because rays are field lines, so any term indexed on the along-channel coordinate must contain **no altitude term** -- the same one-character hazard the raymarch section names. A card IS a column, so `along` and `id` are constant over the whole quad, and every term indexed on either of them moves into the **vertex** shader. That makes the invariant compiler-enforced rather than remembered: an altitude term cannot be smuggled into a value the fragment stage never sees. Checked against `frame.js` before it was relied on -- those terms genuinely take no altitude argument in the raymarch either, so hoisting them is exact and not an approximation. The fragment shader has no noise in it at all.

What moved up there is the whole of the modulation, and it runs at **four scales**: `gate`, a channel switching off over about a minute; `swath`, a long run of one channel dimming to genuine black over tens of seconds while its neighbours stay lit; `patch`, a lit section that drifts *along* its own channel, because the footprint of a beam of electrons moves and that drift is the cheapest cue in the file that this is a process rather than a texture; and `pulse`, the fine chaotic sub-second flicker. `pulse` is **the caustic trick applied to TIME rather than to space** -- two noises drifting at rates with no common factor, multiplied, so it is bright only where both agree, spends most of its life dim and never repeats. Its `* 3.4` is a **mean restore, not a gain**: two value noises average about a half each so their product averages a quarter, and without it switching flicker on would have dimmed the sky fourfold. Four terms rather than one noise with more octaves, because each needs its own rate as well as its own size, and because the eye reads them as four different phenomena.

Two different normalised heights are needed and collapsing them is the trap. `vDep` is the height within **this card's own layer**, so deposition reaches exactly zero at the card's own top edge; `vCol` is absolute altitude against the global `altLow..altHigh`, because colour is a function of altitude and of nothing else. One height would key colour off column height and put a short red column at 150 km beside a green neighbour, which is the "reads as fire" failure arriving from a new direction.

#### What a pixel costs

The whole cost argument is visible in the import list. The card path imports `UTIL_GLSL`, `HASH_GLSL`, `VALUE_GLSL` and `PALETTE_GLSL`, and **not** `GRAD_GLSL`, `FBM_GLSL` or `WARP_GLSL`: there is no gradient noise, no fBm and no domain warp anywhere on the GPU, because the warp already ran once on the CPU and its result is where the triangles are. The gate asserts that absence, since the day a `gfbm2` call reappears in the vertex shader is the day this stops being cheaper than what it replaced.

What is left is **eleven** value-noise lookups per COLUMN in the vertex shader -- the four gating terms, the rays, the flow, the shimmer's two, and the ragged top and wandering hem -- amortised over every pixel that column covers, and a fragment shader with **no noise whatsoever**: two exponentials, a power, three smoothsteps and the palette, call it 35 ALU and no texture fetches. Against the raymarch's ~840 noise lookups per pixel and the ~30 noise-equivalent budget derived from water above.

The cost that replaces it is **overdraw**, and it is real. At the defaults the mesh is **1,967 cards, 3,934 triangles** against the shipped polygon aurora's 35,640, so triangle count is not the question; fill rate is. It got there by going 2.3x denser in columns at 42% fewer triangles in the same round, because a straight card needs no vertical subdivision. What the density buys is continuity: making the curtain read as one sheet rather than a row of separate flames means packing the columns until no single one can be picked out, and the layers over a covered pixel are `2 * reach / spacingFrac`, about **seven** at the defaults against the three it used to be. That is a deliberate trade of fill rate for continuity made before anything was measured on the target hardware, and `spacingFrac` is the knob that trades it back -- the only one that buys down overdraw and triangles at the same time. **None of this has run on a Quest 2.**

#### The blend is a SCREEN, not an addition

An optically thin emitter adds, and this one does not, because seven layers of addition have no ceiling. The material is `THREE.CustomBlending` with `blendSrc: OneFactor` and `blendDst: OneMinusSrcColorFactor`, so `dst = src + dst * (1 - src)` and the N-card composite is `1 - product(1 - s_i)`. Every property additive was chosen for survives, because the product commutes: still order independent, still no sorting, still `depthWrite: false, depthTest: true`, still no per-frame CPU cost.

What it adds is the ceiling, and the ceiling turned out to be the largest single thing making the columns countable. Measured at a 16 degree magnified framing of the shipped defaults, across a frame 97% lit: additive **clipped 51.7% of lit pixels** with at least one channel pinned at 255, and the screen took that to **0.2%** at identical exposure. Clipping matters far more here than a blown highlight usually does, and the reason is *which* part of the sum saturates first. The smooth part of an overlap goes white before the peaks do, so a clipped pixel retains only the GAPS between the brightest cores -- **clipping does not merely brighten a picket fence, it manufactures one out of a curtain that was summing perfectly smoothly underneath.** And the screen compresses exactly where it is wanted: `d(total)/ds = (1 - s)^(N-1)`, so a given per-card wobble moves the result less as the stack brightens, and not at all once it is white. The blend does the last of the blending.

There is **no per-fragment fix**, which is worth writing down because it is the obvious thing to reach for. Tone mapping runs BEFORE the blend, so it rolls off each card's own contribution and then sums those, which does not bound the sum. Bounding the sum needs either an offscreen float target plus a composite pass -- a real cost on a Quest 2 -- or a blend function that is already a roll-off. The one thing it requires in exchange is that each card clamps to 1 in the fragment shader: above 1 the destination factor `1 - src` goes negative and overlap starts *subtracting*, which is dark seams between the columns, a picket fence again by the opposite route.

#### Two things the field decides, and one it is not allowed to

The card half-width is `1 / (2 |grad phi|)`, which is the half-distance to the neighbouring channel. That reproduces the field's crowd-and-thin behaviour exactly rather than imitating it: where the potential steepens the contours bunch and the cards narrow by the same factor, with no term controlling it. Both clamps are load-bearing and for different reasons -- the floor stops a sliver thinner than a pixel aliasing into a crawling dotted line, and the ceiling is not cosmetic at all, because the gradient goes to zero at every extremum and the expression goes to infinity there.

Card **spacing** is the thing the field is not allowed to decide. Measured at the defaults, the unclamped half-distance runs p1 = 14.6 km, p50 = 44.5, p99 = 189.4: a fifteenfold spread, so a fixed spacing sampled the widest channels twelve deep and the narrowest two. The twelve bought nothing, because a wide channel is wide precisely where the potential is flat and there is no fine along-channel detail for the extra cards to carry. Spacing at `spacingFrac` of the local width instead makes the overlap `2 * reach / spacingFrac`, about **7.1x everywhere** at the defaults: a number this code knows and the field cannot change.

#### The picket fence, and where it actually lived

The first frame this technique ever drew was a **picket fence** -- discrete rectangular slabs with hard vertical edges and flat tops, one per card, instead of a curtain. Two independent causes in that frame, each worth stating as a general rule. What took far longer is that the fence outlived both fixes, and the causes that remained were not in the profile at all: they were in the SAMPLING, in the card's own edge, and in the blend the section above replaces. Every one of them looks like a shape problem while you are looking at it, which is why the arithmetic below is written out rather than tuned.

**The units rule.** The raymarch forms its along-channel coordinate from a position already in **field** units, kilometres times `fieldScale`, and at the shipped `0.012` a kilometre is 0.012 of an along unit. `cards.js` bakes honest **kilometres** of arc length into the instance, so `glsl.js` reading `iCard.z` directly ran every along-indexed term about **83x too fast** -- far past the Nyquist limit of a sampling whose cards sit tens of kilometres apart, so the rays, the flow, the shimmer and the patchiness decorrelated completely from one card to the next. The fix is `along = arcKm * u_fieldScale * u_leyAlong`, and `u_fieldScale` is in the shader for that reason alone. The general rule: a term tuned in one coordinate system cannot be transplanted into another by copying the expression, and when the destination is a sampled one the symptom is not "slightly wrong", it is total decorrelation.

**The sampling rule.** A card is a **sample of a continuous curtain**, so nothing in the shader may depend on which card it is. Any per-card random is a sampling artefact by construction: it makes neighbours disagree about a quantity the curtain holds continuously, and at tens of kilometres between cards that reads as a picket fence. The ragged top and the wandering hem each mixed in a per-card hash, which is why every picket had its own independent height. `iCard` is a `vec3` rather than a `vec4` today, and the missing fourth component is that hash.

**The comb rule, which is arithmetic rather than taste and is the one number this technique lives or dies on.** The across-channel halo is `exp(-d*d*skirtTight/(blur*blur))` with `d = reach * |vB.x|`, while the same interpolant places the card's world offset at `u * halfKm`. So the halo's standard deviation is `halfKm / (reach * sqrt(2*skirtTight))` kilometres and the spacing between cards is `halfKm * spacingFrac`. Divide one by the other and **`halfKm` cancels**:

```
sigma / spacing = 1 / ( reach * spacingFrac * sqrt( 2 * skirtTight ) )
```

One number therefore describes how well the whole sky is sampled, no matter how the field crowds or thins. The ripple of a Gaussian comb is about `2 * exp(-2 * pi^2 * (sigma/spacing)^2)`, so a ratio of 1.0 sums flat to **1e-8**, 0.5 is still flat to **1.5%**, and 0.11 has **155% ripple** and is a total fence. Exponential in the SQUARE of the ratio means there is almost no middle ground: it is smooth, and then very suddenly it is a fence. So `skirtTight` is **derived and not chosen** -- set the ratio to one and `skirtTight = 1 / (2 * (reach * spacingFrac)^2)`, which is **12.0** at the shipped `reach` 0.85 and `spacingFrac` 0.24.

**And the fence lived in the narrowest channels.** The old `skirtTight` of 34 put the ratio at 0.59, which is fine, and it *was* fine -- in the channels wide enough to be spaced by the fraction. But spacing is `max(cardSpacingKm, halfKm * spacingFrac)`, and in the FLOOR branch a narrow channel gets a fixed spacing while its halo keeps shrinking with the channel width, so the two come apart. At the old `cardSpacingKm: 5` against `widthMinKm: 4` the ratio was **0.11**, and the floor bound wherever `halfKm < 5 / 0.24 = 20.8 km`, which was most of the sky. That is the whole bug, and the reason it survived is that the obvious place to look for a sampling problem is the widest thing on the screen. The constraint that falls out is `widthMinKm ~= 2 * cardSpacingKm`; shipped now is `cardSpacingKm: 3` and `widthMinKm: 7`, which drops the floor branch to 0.4% of the traced contour instead of most of it.

**The along-channel ceiling** is the other half of the same sampling argument, and it is a real limit rather than a bug. One card holds ONE value of the rays, the shimmer and the flicker, because those are evaluated per column in the vertex shader. The coarsest spacing anywhere in the sky is `widthMaxKm * spacingFrac`, so

```
samples per cycle = 1 / ( freq * leyAlong * fieldScale * widthMaxKm * spacingFrac )
```

and under about five, structure stops being drawn and starts aliasing into a fence. `leyAlong` is the trap here: it multiplies every along-channel frequency at once while looking like a shape control, so raising it from 0.23 to 0.5 halves the sampling of the rays without touching `rayFreq`. The default `rayFreq 6.8` comes out at **5.6 samples per cycle**, right at the edge, and the ragged top and the wandering hem are deliberately the slowest along-channel terms in the file for the same reason. `breakup` and `neon leylines` both carry ray densities well under what they would ask for in a raymarch -- breakup wanted 13.5 and got 4.5 -- and that is the honest cost of the technique rather than a tuning oversight. `widthMaxKm` sits in this equation too, which is why it is not merely a divide-by-zero guard: a card 180 km thick holding a single ray value is a slab, not a curtain, and real auroral arcs are a few kilometres to a few tens thick. It came down from 90 to **40**.

**The hem blur, and the card that had to become a trapezoid.** Cards are blurred wider and softer toward the hem, because that is where the eye finds the seams -- the columns are brightest and sharpest at their bases, so blurring exactly there dissolves them into each other while the fine filament structure higher up survives, and it is right physically as well, the hem being seen through the deepest and most grazing column of scattering air. The bug was that the blur widened the PROFILE and not the CARD. A Gaussian truncated at about 1.2 sigma instead of 3.6 still has a third of its peak at the cut, so every card ended in a roughly **19% hard vertical brightness step** down its own edge, at the same fraction of every card's width. The hem blur was making the columns *easier* to count, not harder. The fix is that the vertex shader widens the quad by exactly the factor the fragment shader widens the profile, from the same expression on the same interpolant -- both stages read `u_hemBlur` and `u_hemBlurSpan` -- so the card has no side edge for the same reason it has no top edge: what is drawn on it has already reached zero before the geometry runs out. The price is that `hemBlur` is now the most expensive knob here in fill rate, because it widens the geometry directly.

**And the profile itself was measured innocent**, which is worth recording because it is the negative result that stops the next person retuning the wrong thing. Rendering the core alone (`scatter` 0), the halo alone (`width` 0.02), and both together at matched unclipped exposure, then measuring band-pass contrast per spatial scale against a deliberately built fence as a control (which read 40-53%): the halo alone is flat at **0.8-2.2%**, the core alone genuinely ripples, up to **8.7%** at 13 px, and the two together are flat at **0.5-2.5%**. Doubling the card density -- `spacingFrac` 0.24 to 0.12, 1,967 cards to 3,452 -- made the comb slightly **worse**, not better. The columns were never what made the columns visible. The clip was, which is the section above.

#### The schema rule that shapes the whole page

`uniform: true` and `REBUILD_KEYS` must be **disjoint**, and the design pressure is always toward the uniform side. A uniform is a slider you can drag while looking at the sky; a rebuild key is a slider that stutters, because moving it re-runs the CPU trace. Two parameters had to be restructured to stay on the right side of that line: `reach` is applied as a multiplier in the shader with the bare half-distance baked into the instance, and the trace grid is centred on the **eye** rather than on `beltOffset` so the belt stays draggable. The belt term has a floor of `1 - beltAmt` anyway, so at any strength short of one there is lit sky behind you, and a grid centred on the belt would leave it with no contours in it at all.

The mesh is **sky-locked**: its origin is copied onto the eye every frame. At 100 km up, walking the entire 16 km world moves a channel under five degrees, so parallax would be a lie in the other direction -- the aurora would visibly slide past the mountains as you walked. Locking it also makes the eye the origin of the shader's own space, which is what lets the vertex shader billboard without a `cameraPosition` lookup. `KM_TO_WORLD = 22` cancels visually, since apparent size depends only on the ratio of altitude to plan distance and this scales both; it exists solely to place the geometry between the backdrop cap at 1,500 and the far plane at 40,000.

#### Layout

```
test-aurora-v2.html                 route
src/test-aurora-v2-main.js          the page: camera, clock, stars, panel wiring
src/aurora-cards/field.js           the ley-line potential, ported to JS
src/aurora-cards/trace.js           marching squares -> smoothed, arc-resampled polylines
src/aurora-cards/cards.js           polylines -> one InstancedBufferGeometry of columns
src/aurora-cards/glsl.js            CARD_VERT and CARD_FRAG
src/aurora-cards/params.js          the param schema and REBUILD_KEYS
src/aurora-cards/presets.js         five partial tunings
src/aurora-cards/curtains.js        assembles the shader, owns the mesh and the uniforms
```

The schema is a separate file from `aurora-lab/algorithms.js` rather than a ninth entry in it, and the reason is structural: `SHARED_GROUPS` unconditionally concatenates about 60 raymarch parameters (`steps`, `stepBias`, `dither`, `persp`, the whole March quality group), and `applyParam`'s fall-through throws on the first one a card technique cannot route. The presets here are **partial** rather than snapshots, so a preset states only what it changes -- a full snapshot pins any newly added parameter to whatever it happened to be on the day the preset was written, silently. No preset touches the trace group, because those keys stutter and none of them is a look; they are a budget.

#### What is verified, and what is not

`node scripts/check-aurora-cards.mjs` and `npx vite build` both pass. The gate parses every module, sweeps for the stray-backtick-in-a-GLSL-comment failure the section above records (an even count of strays leaves the file parsing and the shader silently missing its second half), runs the trace against the shipped defaults, asserts that `uniform: true` and `REBUILD_KEYS` are disjoint, cross-checks that every `u_*` the GLSL reads is a schema key or one of the three named synthetics (`u_time`, `u_kmToWorld`, `u_fieldScale` -- listed by name rather than matched by a prefix, so a fourth has to be added there deliberately), asserts no GPU-side `warp2` / `gfbm2` / `gnoise2`, and asserts that the vertex shader's `gate` / `ray` / `flow` / `caus` assignments mention no altitude term.

It also **compiles both stages and links the pair**, which closes the hole the raymarch section names as the gate's largest blind spot -- the duplicate declaration that shipped, was never linked, and survived a full gate run. It reconstructs three.js's own `ShaderMaterial` prologue (including the `pc_fragColor` alias three emits for non-GLSL3 materials) and runs `glslangValidator`; a missing validator prints SKIP and exits 0 rather than turning the gate red. Negative tests confirmed the link stage is doing real work: a `vec2`/`vec3` varying mismatch compiles clean in **both** stages and fails only at the link, and a syntax error reports a line number relative to the GLSL literal rather than to the assembled source. The opposite direction is enforced at construction rather than in the gate: `curtains.js` throws if the schema declares a uniform no shader reads, because that is a slider wired to nothing, and silently doing nothing is the worst behaviour a tuning control can have.

Not verified:

- **It has never run on a real GPU.** It does now render, on a real WebGL2 context, via headless Chrome on SwiftShader driven by `aurora-cards-probe.html` -- a throwaway probe that exists because a card aurora has four distinct ways to link cleanly and draw nothing (an attribute name that no longer matches the geometry, an `instanceCount` of zero, a gate that collapses every quad, a bounding sphere that culls the sky) and every one of them looks exactly like a tuning gone dark. It reports lit-pixel counts per preset, confirms `gain 0` collapses every quad to zero lit pixels, confirms sky-lock is byte-identical across an 11 km walk, and captures a PNG per preset. Software rasterisation says nothing about speed. `aurora-cards-zoom.html` is its magnifier and is where every clip and contrast figure above was measured: at the probe's 480x300 across a 62 degree field one card is a couple of pixels wide, so the difference between a curtain and a fence sat below the resolution of the only picture anybody was looking at, which is how a picket fence survived a round of tuning aimed straight at it. The zoom shoots 900x600 at 16 degrees instead, at the hem and at the upper third, which are the two places the columns have historically separated.
- **Nothing has run on a Quest 2**, so whether overdraw or triangle count binds first is unknown.
- **Framing has been measured but not judged.** The aurora used to fill the whole upper hemisphere rather than reading as a band, and the cause was arithmetic rather than taste: the belt term has a floor of `1 - beltAmt`, so at the old `beltAmt 0.5` half the light was still there in every direction and facing south measured 48.1% lit against north's 46.4%. Only a value of **1** gives a genuinely dark south, and the width has to be read against the distance -- a band wider than it is far has its near edge overhead and its far edge behind you. Shipped now is `beltAmt: 1, beltOffset: -450, beltWidth: 430, beltPow: 2.6`, at which south measures **20.7% of north's mean** (28.2 against 136.3) and 6.7% lit against 57.0%. The page starts facing due north, which in three.js `YXZ` order is yaw 0 looking down -z. No human has looked at any of it at a real field of view.
- **Topology does not morph.** The trace runs once and the gating, the flicker and the shimmer animate in the vertex shader within that epoch, which is physically right at short timescales -- a real arc holds its structure for minutes while its rays writhe in seconds -- but a substorm reshapes the topology and this cannot follow it. `traceTime` exposes a manual re-trace and stutters by design. The fix is a Worker re-trace with a crossfade between two card sets.

### Stars

2,400 points, spectral tints weighted to a real-ish O-through-M distribution, sized and brightened by magnitude with saturation rising with brightness. The Milky Way is **rejection sampling on the CPU** -- a density gradient in the point distribution, costing exactly zero shader instructions. Twinkle is two out-of-phase sines whose amplitude rises near the horizon, because scintillation is an air-mass effect and stars overhead barely twinkle at all. The field rotates about the true celestial pole for the world's latitude.

**`gl_PointSize` is a count of FRAMEBUFFER pixels**, so a star's size on screen is fixed only as long as the framebuffer is. `uPixel` was set once at construction, so dropping the lab's render scale shrank the drawing buffer without shrinking the stars: each one kept its pixel count, covered four times the fraction of the screen at half scale, and was magnified again by the upscale to CSS size -- which read as the stars burning in and getting brighter as the sky got cheaper. `setPixelRatio()` exists for it and `resize()` in `src/test-aurora-main.js` calls it with the renderer's actual ratio. It was never anything to do with the aurora's translucency; additive blending strictly adds, and there is no feedback buffer anywhere on the page.

### Night-sky banding

An 8-bit framebuffer bands visibly across a dark full-screen gradient. A quarter-LSB hash dither fixes it, and it has to be applied **after** the sRGB conversion, not before: near black, one 8-bit code step is about 0.0003 in linear space, so a dither sized in linear units is either invisible or enormous depending on where in the gradient it lands.
