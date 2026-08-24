# Aurora rounds four, five and six -- superseded

**None of the code described here is in the tree. Do not use this file for current behaviour** -- see `design/13-aurora-and-sky.md` for what actually runs.

Round seven reverted `src/aurora.js` and `src/aurora-patterns.js` wholesale rather than patching forward, because rounds five and six had never drawn a pixel (round five shipped a duplicate `mScale` that stopped the shader linking). §13 records the revert target as "the commit before round five", which would have left round four standing. It did not: as of this writing the tree has **16 forms**, `MAX_RADIUS_KM = 333`, no `twist`, no `flame` and no `retired:` rows, and `src/aurora.js:480` carries round *three*'s presence envelope verbatim. So round four went with them, and the "catalogue got shorter" heading below describes a catalogue that is not shorter.

What survives from these rounds and is live today: round five's `curl` / tangential-footprint construction (`src/aurora.js:265`, `:399`), and round six's same-scope redeclaration scanner in `scripts/check-daynight.mjs`. Both are documented in the current file, not here.

Kept because the *arguments* still hold and re-deriving them costs more than reading them: an envelope's blur radius is its wavelength; apparent size and distance are one knob; a polar-coordinate footprint is a polar graph and inherits its symmetries.

---

### Round four: shear was not enough, and the catalogue got shorter

Round three's presence envelope, its vortices and its flaming form were all judged from inside the headset and all three came back wrong in the same way -- the *mechanism* was right and the *magnitude of the right axis* was not. The catalogue went 16 forms -> **12**, and three new per-band parameters exist.

#### The blur radius of an envelope is its wavelength

> *the blur envelope feels too narrow, so I'm seeing this very confined triangle of a curtain*

The instinct on hearing "the blur is too narrow" is to soften the transfer curve -- widen the `smoothstep`. That is the wrong knob and it produces a *dimmer* hard edge rather than a soft one. **What sets the visual softness of an envelope is the wavelength of the noise carrying it**, because that is what decides how many metres of sky the transition is spread across. Round three's octaves were 161 km and 48 km. At a band 250 km out those subtend a few degrees, which is the "confined triangle": the edge is sharp because it is short.

So the envelope was rebuilt as two octaves with *different jobs* rather than two octaves of the same job:

```glsl
float macA = aurNoise( vec2( km * 0.0028 + E.z * 0.7, t * 0.052 ) );   // 360 km, slow
float macB = aurNoise( vec2( km * 0.0069 + E.z * 2.3, t * 0.285 ) );   // 145 km, 5.5x faster
float region = smoothstep( 0.18, 0.88, macA );
float wash   = smoothstep( 0.06, 0.94, macB );
float presence = mix( 1.0, 0.08 + 2.55 * region * region * ( 0.22 + 0.78 * wash ), F.w );
```

`region` is which stretches of the band are lit tonight; `wash` is the flicker moving across them. They **multiply rather than sum**, and that is the load-bearing choice: summed envelopes regress toward their mean, so a band is always about half lit and never absent, while multiplied ones let either term veto -- which is what "mostly absent, occasionally blazing" actually is. The per-band seed offsets (`E.z`) are new too. Without them every band in the sky shares one envelope at a given `km` and they all fade in unison, which reads as the renderer dimming rather than as weather.

#### The hem has to snake, and perspective alone cannot do it

> *the bottom line of the curtain waves a little, but it should be dramatically waving across the sky ... very serpentine rather than one long flat line*

The honest mechanism for a wandering hem is perspective on a meandering ground track, and it is **bounded by the camera**: a band 250 km out cannot fold 60 km outward and still fit a 444 km far plane, and folding it that far buys only about 2 degrees of apparent vertical swing anyway. So the work is split between two terms with different costs.

- **A meander octave in** `aurFold`, weighted **2.30** against the base octave's 1.0 and four times its wavelength. Deliberately *not* scaled by the per-band `foldHz`, because otherwise a form with tight folds stops snaking and goes back to a ruled line -- the meander is the band's course across the sky, not its texture. This costs far-plane budget, and three bands had to be trimmed after it landed.
- **A "swoop"** that slides a whole column bodily up and down. It moves `baseKm` and `topKm` together, so the *normalised* deposition curve is untouched -- the colour ramp and the hem softness are functions of `h` in column-local space and cannot see it. It costs no radius at all.

Both amplitudes are tied to `fold`, so a form still has one sinuousness knob rather than three that have to be kept in agreement.

This changed the gate's arithmetic in a way worth recording. The fold bound was `0.5 x sum(weights)`, which is now 2.08, and applying that to every fence flagged eleven bands as too low or too overhead. The bound is not wrong -- it is the right bound for *the far plane*, where clipping even once a night is a visible bug. It is far too pessimistic for the **aesthetic** fences, because it prices a configuration where all four octaves peak in the same direction at the same instant. So the gate now carries two constants: the worst case for radius, and `0.45x` that -- about two sigma for a sum of four independent terms -- for the elevation fences. `elev 13.2..89.4` became `elev 16.5..75.2` with no change to the shipped catalogue.

#### Shear leans, twist turns -- and the difference is the whole vortex

> *Pattern 13 doesn't at all look like a vortex, it just looks like a triangle*

Round three built four "vortex" forms out of one parameter, `shear`. `shear` **offsets where the fold noise is sampled as a function of altitude.** The pattern therefore leans -- but the sheet it is drawn on is still a flat ribbon standing on a fixed ground track, so from any single viewpoint it is a leaning triangle. There is no far side, because there is no side.

The new parameter is `twist`**: degrees of *footprint azimuth* per km of altitude.** It rotates where the column *is*, not where its texture is sampled, so the band becomes an actual helix with a near limb and a far limb that you can walk around and look up into. It required reordering the vertex shader -- `km` is now computed first, because the azimuth depends on altitude, altitude depends on the per-column terms, and every one of those is a function of `km`, which itself depends only on `aU`.

The gate's vortex check now requires **both** `shear > 0.8` and `twist > 0.1` on every band, which is precisely the failure that shipped last round.

#### Flaming is brightness, not structure

> *there's not any pale light racing up into the sky as it describes*

Same class of mistake. Round three built flaming out of `shear` plus a negative `drift`, so what travelled upward was the *fold pattern* -- and a fold moving up an already-twisting column is not separable by eye from the twist.

Real flaming aurora is a disturbance propagating along a field line, and **the thing that moves is brightness**. So `flame` is a travelling wave on the deposition curve in the fragment shader:

```glsl
float wave = 0.5 + 0.5 * sin( ( h * 2.8 - uTime * 1.1 ) * 6.2832 + km * 0.055 );
dep *= mix( 1.0, 0.20 + 1.90 * pow( wave, 3.0 ), vCol.w );
```

This is **the one legitimate altitude term in the whole system**. §13's rule is that all *structure* is field-aligned and therefore no structural noise may contain a height term -- put one in the ray or fold lookup and the aurora becomes coloured fog. A brightness wave is not structure: it rides on `dep`, which is already a function of height, and nothing that defines the silhouette can see it. The gate asserts both halves -- that the wave is on `dep`, and that the ray lookup still contains no `h`.

#### Retiring forms without losing them

Four forms were cut: diffuse patches, pulsating patches, SAR arc and smoke plume. They are **not commented out.** Each row carries a `retired: '<why>'` string and `PATTERNS` is filtered out of a full `ALL` array.

A commented-out block is dead text -- nothing parses it, so its numbers drift out of agreement with the shader, and by the time you want the form back it no longer runs. A retired row is still a live object: the gate's geometry sweeps still see it, so it still has to fit the far plane, and it can be restored by deleting one line. The cost is exactly one new failure mode -- a retired row leaking back into `PATTERNS` -- which is what the two new checks catch.

Retiring diffuse patches had a consequence that nearly shipped as a bug: **it held** `floor: true` **and the two reserved slots**, so cutting it would have removed the guarantee that the sky is never empty. `quiet arc` was promoted to the floor and given a second band, which keeps `FLOOR_BANDS = 2` and `SLOTS = 11` exactly as they were.

One more: `STEVE` was declared the rarest form with `gate: 0.78` on a 24.8 h period, and drew **zero frames in a simulated fortnight**. Thirteen cycles of the selector noise is too few draws for a threshold that high, so "rarest" had quietly become "never". A shorter period (19.3 h) and a slightly lower gate (0.72) give the same ~0.6% duty at a sample count where that number means something. The pre-existing "every named form actually occurs" check is what caught it.

Twelve forms, `rMax 405 of 444 km`, `elev 16.5..75.2`, and the same eleven slots and 35,640 triangles as round three.

### Round six: apparent size is not a free variable

*Reverted in round seven above -- none of the re-siting described here is in the tree. Kept for the argument, which stands: distance and apparent size are one knob.*

Round five below moved every band outward to put its hem near the horizon, verified that the hems had arrived, and shipped. The report was **"no auroras show up at all"**, and it was accurate.

What the gate never measured was what the move cost. Distance and apparent size are one knob, not two: pushing a band from 263 km to 1,180 km drops its hem from 20.8 degrees to -0.4, and in the same stroke shrinks it from 11.8 degrees of sky to 3.4. The always-on quiet arc became two ribbons 3.4 and 5.1 degrees tall, sitting in the part of the sky where the extinction term was also cutting them to a fifth. On an ordinary night -- which is quiet-arc-only, since it is the floor form -- that is a faint smear along the horizon and nothing else. Two thin dim ribbons is, for practical purposes, no aurora.

The way out is the third variable, which had been sitting untouched at ~170-250 km: **the top of the band**. Both the hem angle and the top angle scale as 1/distance, so raising `alt1` restores the angular height that distance took away, at any distance. And it is nearly free in two separate ways. It is free physically, because rayed structures genuinely reach 300-400 km -- the red-topped tall rayed band is one of the most photographed shapes there is. And it is free in the shader, because the deposition profile is normalised over each column's own height (`h = (alt - base) / (top - base)`), so a 300 km column is a *bigger* band, not a dimmer one.

Every form was re-sited a second time on that basis, as a **ladder rather than a shove**: a far low band whose hem is 0-5 degrees up, plus nearer bands that carry the mass. `multiple arcs` now runs 1,160 km / 620 / 300, from a band whose base is 0.2 degrees *below* the horizon to one reaching 38 degrees up -- 38 degrees of sky in one form, with a genuine below-the-horizon accent in it. The quiet arc is 960 km and 300 km, 1.7 to 40 degrees. Every named form is at least 10 degrees tall and ten of the twelve span 25 or more, against a headset field of view of about 50 degrees vertical.

The horizon extinction was narrowed to match. It reached full brightness at 5.7 degrees, which is precisely the band of sky the curvature term had just been built to fill -- so it was deleting the thing it was supposed to make possible. Now half strength on the horizon line and full by 2.6 degrees. The hard cutoff below -2.6 stays, because it is what stops a band whose base has sunk below the horizon from being drawn out over open ground past the edge of the terrain, where there is no depth buffer to occlude it.

Four checks were added, and they are the point of the round more than the numbers are. The gate now prints every form's vertical extent and asserts a floor on it, a floor on how many forms are "large", a separate floor on the always-on form, and a ceiling of 450 km on `alt1` so a form cannot buy its size by leaving the atmosphere. **A gate that measures where something is and not how big it looks will pass a catalogue that has been optimised into invisibility**, which is what happened, and it is the kind of failure that only a check written in the user's units can catch.

### Round five: it was a polar graph, and the far plane was buying nothing

*Reverted in round seven above, except where noted there: the tangential footprint and the trochoid offset predate this round and are still in the shader; the shell, the curvature drop, the swoop and the re-siting are gone.*

Three complaints, and the first two turn out to be the same bug: *"they still seem like mostly straight, slightly wavery -- they're not folding back and forth on top of each other... the same segment never folds back over itself, but it should"*, *"many times the aurora should appear like just above the horizon, maybe even coming up from below the horizon, and quite large scale"*, and *"is that just a limitation of the shader?"*

**It was a limitation, and it was one line.** The footprint was

```glsl
vec3 p = dir * ( dist + fold ) + vec3( 0.0, alt, 0.0 );
```

which is a **polar graph**: radius as a function of azimuth. A polar graph is single-valued in its angle by construction. No amplitude, no octave count and no noise seed can make it double back, because two points on the band can never share a bearing. It can wander toward and away from the viewer, and perspective turns that into a hem that rises and falls -- so it *flaps* -- but a fold-back is topologically unavailable. Every round up to four had been tuning the amplitude of a shape that could not fold.

The fix is a **tangential** component. `aurFold` returns a `vec2` now: `x` along the footprint normal as before, `y` along the tangent, and the position is

```glsl
vec3 p = dir * gd + tng * f0.y + vec3( 0.0, alt - drop, 0.0 );
```

That makes the footprint a general parametric curve in the ground plane, and a general curve may loop. Walking the band, along-track speed is `1 + d(tangential)/d(km)`; where that goes negative the track reverses and the same stretch of sky gets two pieces of curtain, one behind the other. Being optically thin and additive, the overlap is *brighter*, which is what the photographs show.

The tangential octaves are **the same noise sampled a quarter wavelength along**. A quarter-wave offset between two components traces a circle, so each octave contributes a loop rolled along the band -- the trochoid family, which is what an auroral curl physically is. Independent noise in the second axis was tried first and gives a curve that wanders in two axes without closing: jitter, not coiling.

`curl` is the per-form tangential amplitude as a multiple of the radial one, and it is allowed past 1 because the two axes cost different things: the radial component is depth, which the eye barely reads at 300 km, while the tangential component is all visible.

#### The gate had to grow a noise implementation

"Does it fold back" cannot be read off a parameter -- two bands with identical `curl` fold a different number of times depending on fold wavelength, span and distance. So `aurHash`/`aurNoise`/`aurFold` are ported to JS in `check-daynight.mjs` (the uint32 wrap is `Math.imul(x >>> 0, k) >>> 0`), the footprint is walked, and the measurement is **the number of times its bearing reverses** -- zero being exactly the old polar graph. Measured per frame, worst band of each form:

|  |  |  |  |
| --- | --- | --- | --- |
| quiet arc 5.4 | multiple arcs 6.3 | rayed band 15.5 | drapery 18.1 |
| corona 8.6 | breakup 28.4 | omega band 2.9 | picket fence 4.6 |
| STEVE 0.3 | vapour spiral 2.2 | rising column 4.3 | flaming aurora 12.4 |

Two reversals is one loop. The gate asserts at least nine of twelve forms average two or more, that the always-on floor form is one of them, **and that at least one form stays straight** -- STEVE is a narrow ribbon, not a curtain, and a catalogue where everything writhes is as wrong as one where nothing does.

The three structural octaves were also slowed about a third (0.020/0.055/0.130 -> 0.014/0.038/0.085). A fold that comes and goes in eight seconds reads as flicker; the same fold over twelve to fifteen seconds reads as the sheet winding and unwinding. The fourth octave stays fast on purpose: that one is the breakup flicker.

#### The shell: the far plane was pricing something nobody could see

The near-horizon half of the request was blocked by arithmetic. A 100 km band whose hem sits 4 degrees up is 1,400 km away; at 45 units/km that is 63,000 units against a 20,000-unit far plane. Three rounds had been spent trimming folds and altitudes to fit inside 444 km.

But **an aurora's distance is not an observable.** It is sky-locked (walking the whole 16 km world moves it under 5 degrees) and 250 km is infinity to a 64 mm interpupillary baseline, so there is no parallax and no stereo disparity. Everything you can see about an aurora is its direction and its colour. So the finished position is normalised onto a shell at 14,000 units -- past the far corner of the world (11,600) and inside the far plane -- and distance becomes free.

This *improves* occlusion rather than compromising it: every aurora fragment is now further away than every mountain, so the only thing that can hide an arc is a silhouette in front of it, which is the only thing that should.

#### And then the Earth had to be round

Freeing the distance was not enough on its own, because on flat ground elevation is `atan(alt / dist)` and a 100 km band at 1,200 km is still 4.8 degrees up -- it never reaches the horizon, it just asymptotes. The missing term is the ground falling away:

```glsl
float drop = gd * gd / 12742.0;   // d^2 / 2R, R = 6371 km
```

Under a band 1,000 km away the ground has dropped 78 km below the tangent plane you are standing on, so a base at 101 km altitude is 23 km above *your* horizontal -- 1.3 degrees, not 5.8. Past about 1,130 km the base has gone under the horizon and only the tops of the rays show. That is the requested sight, and it is not a hack: it is the single largest effect acting on where a distant band appears, and every photograph of a low arc is showing it.

It is applied **only to the position**. `vShape` carries the true altitude, because altitude is what sets the colour and the deposition profile and neither cares where the observer stands. The gate asserts the ordering in the source, which makes the mistake structurally impossible rather than merely absent.

It also uses `gd` (distance *including* the radial fold) rather than the band's nominal distance, so a stretch folding 60 km further out sinks another 11 km and the hem weaves across the horizon line for free -- the honest version of what the `swoop` hack approximates.

#### Two lengths are now measured in degrees, not kilometres

The **meander** and the **swoop** are the structures whose size the eye judges angularly. Left metric, a 1,000 km arc showed four times the swings of a 250 km one across the same span of sky -- texture instead of a course. Both are now scaled by `mScale = 250 / dist`, normalising them to a 250 km reference band. Everything else stays metric, because folds, curls and rays are real lengths and really should get finer with distance.

The swoop also gained a cap, `min(fold, 26)`. Amplitude was tied to `fold` so a form has one sinuousness knob, but the far bands now carry folds of 60-130 km, and a hem sliding 60 km up and down is not a swoop -- it is the band leaving the altitude range that gives it its colour.

Extinction was widened to match: `smoothstep(-0.05, 0.10, view.y)` from `(-0.03, 0.14)`. The old window reached full brightness by 8 degrees, which was fine when nothing was catalogued below 13 and would have deleted the picket fence and most of the far arcs outright.

#### The catalogue, re-sited

Distances went from 94-288 km to 94-1,180 km, and hems from 16-75 degrees to **-0.4 to 69**. Eight of twenty-nine bands sit within five degrees of the horizon, including the floor form's, so an ordinary night has a low arc. `picket fence` moved to 900 km, where it stands on the skyline at 2.3 degrees, which is how picket fences are actually seen. `corona` did not move at all -- it is the zenith form.

`MAX_RADIUS_KM` changed meaning with everything else: it was a projection-matrix limit (365 km), it is now a physical one (1,600 km), the distance at which curvature has swallowed even the tallest band's top.

Twelve forms, hems -0.4 to 69 degrees, and the same eleven slots and 35,640 triangles as round three.

---
