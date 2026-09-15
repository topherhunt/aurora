// ---------------------------------------------------------------------------
// RELIEF -- the opt-in jaggedness knobs, and the one place their defaults live.
//
// Three-free and node-runnable, like everything under src/v2/height/.
//
// WHY THIS FILE EXISTS AS A FILE. The composed height field is evaluated in
// THREE places at once: the main thread (player collision, editor raycast, prop
// scatter) and each terrain worker (the mesher). They do not share memory. If a
// knob reaches one and not the others, nothing throws -- the ground she is drawn
// standing on and the ground she collides with become two different surfaces and
// she hovers or sinks, silently. This is the same failure V2Height's WORLD_SEED
// comment describes, and the answer is the same: one module, one shape, one
// validator, and a transport that refuses anything that did not come through it.
//
// EVERY KNOB'S OFF VALUE IS ZERO AND ZERO MEANS BIT-IDENTICAL. Not "close to",
// not "visually the same" -- with an all-zero relief every branch below is
// skipped outright and V2Height computes exactly the expression it computed
// before any of this existed. check-v2-field.mjs asserts that against a field
// constructed with no relief argument at all, because a default that quietly
// changed the world would make every one of the other assertions in that gate a
// measurement of a different terrain than the one that shipped.
//
// `talus` and `jitter` are the exceptions to "zero is off", and neither is a
// knob in the same sense: one is the repose angle the erosion pass relaxes
// toward, the other the fraction the jagged stack's lattice may deviate by, and
// each is meaningless and never read while its parent is 0. Both carry `needs`
// so the HUD can grey them out and the gate can skip them in the all-off
// assertion.
// ---------------------------------------------------------------------------

/**
 * The knob table. The HUD builds itself from this, the validator clamps from
 * this, and the gate iterates it -- so adding a knob is one entry here and a
 * branch in the field, and it cannot be added to the panel and forgotten in the
 * transport.
 *
 *   off   the value that means "this term does nothing"
 *   on    what the HUD's toggle button sets when you switch it on. Chosen to be
 *         clearly visible rather than tasteful: this is an ablation tool, and a
 *         knob whose ON state you have to squint at teaches nothing.
 *   step  one scrub tick in the HUD (see Panel._attachScrub)
 */
export const RELIEF_KNOBS = Object.freeze([
  {
    // THE ABLATION KNOB FOR THE WHOLE PROCEDURAL TERM, and the one to reach for
    // first when asking "what is the imported field actually shaped like".
    //
    // It scales the DETAIL stack only -- the crag band is a separate term with
    // its own knob and its own amplitude, and muting both from one switch would
    // make the answer to "what does bare macro look like" depend on a knob this
    // one does not name. Turn crag off too (it already is, by default) for the
    // import and nothing else.
    //
    // Applied OUTSIDE Detail rather than by scaling `rough`, because
    // calibrateRough fits the stack against the import's structure function and
    // a scale factor inside that fit would be re-measured away. Outside, `bare`
    // is a clean fade and the calibration never moves -- so scrubbing it 0 -> 1
    // and back lands on exactly the field you started with.
    key: 'bare',
    label: 'bare macro',
    hint: 'fade out the procedural detail term and show the imported macro field alone',
    off: 0, on: 1, min: 0, max: 1, step: 0.05,
  },
  {
    // THE OTHER STACK. Not a term added to the smooth field but a replacement
    // for it: the macro is read bilinearly instead of through Catmull-Rom, and
    // the simplex octaves give way to lattice midpoint displacement with a
    // crease on every lattice line. See jagged.js. Two knobs go dead under it:
    // `crease`, there being no bicubic dome to undo, and `sharpen`, which is
    // Detail's own rectifier. `bare`, `exposure` and the added terms wrap the
    // detail output from outside and act on the jagged stack as they would on
    // the smooth one. The calibration is unchanged: the sub-metre layers take
    // the amplitudes the smooth stack was fitted to.
    key: 'jagged',
    label: 'jagged',
    hint: 'replace the smooth stack: bilinear macro plus creased lattice jitter, no curve anywhere',
    off: 0, on: 1, min: 0, max: 1, step: 1,
    integer: true,
  },
  {
    // The jagged stack's coarse-layer fraction: each lattice midpoint above 1 m
    // deviates from its parent by up to this times the macro's rise across the
    // parent cell. A value, not a switch, like `talus`: 0 is the ablation that
    // leaves only the bilinear macro and the calibrated sub-metre layers.
    key: 'jitter',
    label: 'jitter',
    hint: 'fraction of the parent cell\'s rise a jagged lattice point may deviate by, for the layers above 1 m',
    off: 0.2, on: 0.2, min: 0, max: 1, step: 0.05,
    needs: 'jagged',
  },
  {
    key: 'sharpen',
    label: 'sharpen',
    hint: 'rectify the detail octaves into creased ribs instead of gaussian lumps',
    off: 0, on: 0.7, min: 0, max: 1, step: 0.05,
  },
  {
    key: 'exposure',
    label: 'exposure',
    hint: 'convexity drives detail amplitude -- ribs rough, hollows smooth',
    off: 0, on: 1, min: 0, max: 1, step: 0.05,
  },
  {
    key: 'crag',
    label: 'crag',
    hint: 'metres of crease relief on convex steep ground at 24-96 m: ribs up, bowls down',
    off: 0, on: 12, min: 0, max: 30, step: 0.5,
  },
  {
    key: 'aniso',
    label: 'aniso',
    hint: 'stretch the crag band down the fall line, so gullies run downhill',
    off: 0, on: 1, min: 0, max: 1, step: 0.05,
    needs: 'crag',
  },
  {
    // THE ONE TERM IN THE SET THAT IS NOT A NOISE BAND. Every other knob here
    // adds or shapes a field that is a function of (x, z) alone, and a field
    // with no preferred direction is isotropic by construction -- which is why
    // `crag` at full tilt reads as crumple rather than as rock no matter how far
    // it is pushed. This one reads a ridge axis out of the coarse field's own
    // Hessian and cuts along it, so the same crease operator gives teeth down a
    // skyline and ribs down the faces between them. See ridge.js.
    //
    // Its units are metres of half-range summed over three detection scales, so
    // it is directly comparable to `crag` and the two can be A/B'd against each
    // other at equal amplitude. 12 to match crag's ON for exactly that reason.
    key: 'ridge',
    label: 'ridge',
    hint: 'metres of teeth and ribs cut ALONG the spines the coarse field already has',
    off: 0, on: 12, min: 0, max: 40, step: 0.5,
  },
  {
    // THE SAME GATE AND THE SAME AXIS AS `ridge`, A DIFFERENT OPERATOR -- and the
    // second half of the argument that knob started. `ridge` proved a directed
    // term can be gated onto the spines; it also proved that smearing noise ALONG
    // a direction is how you synthesise a fingerprint, because a function of
    // along-crest position extruded down the faces has parallel level sets and
    // creases at evenly spaced intervals. No amplitude fixes that.
    //
    // This one lays a jittered Voronoi lattice over the ground and takes the
    // upper envelope of a tilted pyramid per cell: every point sits on some
    // facet, facets meet at edges, and the tall cells overrun their neighbours so
    // the spacing sets itself. It shares `ridge`'s baked structure outright, so
    // turning it on costs no extra bake and no extra memory, and it is in fact
    // the cheaper of the two per sample -- nine table lookups against fifteen
    // simplex taps. See ridge.js.
    //
    // ITS UNITS ARE NOT `ridge`'s, despite both being metres, and the two are
    // therefore NOT comparable at equal numbers the way `ridge` and `crag` are.
    // `ridge` is an rms; this is a PEAK, the height a maximal shard stands proud
    // summed over the three scales, because a field that is flat over most of its
    // domain and spikes over the rest has an rms nowhere near its extremes. 40
    // here is roughly 12 there.
    //
    // ON at 45 rather than at `ridge`'s 12 for exactly that reason: it is the
    // value that puts the same rms displacement on saturated ground, so switching
    // between the two knobs compares the two OPERATORS rather than comparing one
    // of them against a quieter version of the other.
    key: 'shatter',
    label: 'shatter',
    hint: 'metres of FACETED rock -- tilted pyramids meeting at crisp edges, on the same spines `ridge` finds',
    off: 0, on: 45, min: 0, max: 90, step: 1,
  },
  {
    // THE ONLY KNOB HERE THAT CHANGES HOW THE IMPORTED FIELD IS READ, rather
    // than adding a term on top of it or scaling one that is already there. See
    // crease.js.
    //
    // The macro layer is 1024 texels over 8 km and Catmull-Rom draws the curve
    // between them. On a crest it CANNOT draw anything but a dome: the tangent
    // it uses at texel k is (h[k+1] - h[k-1]) / 2, and on a crest both
    // neighbours are lower, so the tangent goes to zero and the cubic leaves
    // flat and falls away both sides. `crag`, `ridge` and `shatter` are all
    // attempts to put an edge back on top of that dome. This one declines to
    // round it off in the first place, by extending the two straight faces
    // either side until they meet and restoring the corner between them.
    //
    // AND THE CORNER IS REALLY IN THE DATA. check-v2-field.mjs fits a tent and a
    // dome to every crest cross-section in the RAW texels: the import prefers
    // the tent at 75% of crests, the same field blurred prefers it at 49%, and
    // over 50 m of relief the gap widens to 0.77 against 1.95. So the interpolant
    // is discarding a crease that the imported texels have, and this is a
    // recovery rather than an invention -- which is also why it needs no crest
    // detector: the amplitude is the terrain's own curvature, so a broad hilltop
    // gets a few centimetres and an arete gets metres.
    //
    // ITS UNITS ARE NOT METRES, unlike `crag`, `ridge` and `shatter`, and it is
    // NOT comparable to them at equal numbers. It is an EXAGGERATION: 1 restores
    // exactly the corner the geometry implies and nothing more, 3 overdraws it
    // 3x. There is no metre value to state because there is no fixed amplitude
    // -- a 10 m tooth and a 10 cm one come out of the same knob on different
    // ground, which is the point of it.
    //
    // ON at 3 rather than at a faithful 1 because this table is an ablation
    // tool: at 1 the operator moves the surface by an rms of 0.13 m and you have
    // to hunt for it, at 3 it is 0.38 m and the skyline visibly grows teeth.
    key: 'crease',
    label: 'crease',
    hint: 'reconstruct the macro field so crests KINK instead of doming -- an exaggeration, not metres',
    off: 0, on: 3, min: 0, max: 6, step: 0.25,
  },
  {
    key: 'erode',
    label: 'erode',
    hint: 'thermal (talus) relaxation passes over the imported field -- ~190 ms to toggle',
    off: 0, on: 20, min: 0, max: 40, step: 1,
    integer: true,
  },
  {
    key: 'talus',
    label: 'talus deg',
    hint: 'repose angle the erosion relaxes toward: lower is more scree, higher keeps the cliffs',
    // 55 rather than a real-world repose angle of about 34, because this import
    // is stretched 3x (world/height.json `exaggeration`) and the angle is
    // measured in the stretched metres the field is actually in -- 55 deg here
    // is atan(tan(55)/3) = 25 deg of real hillside. Measured against the shipped
    // field's own texel-to-texel drop distribution (p50 20 deg, p75 30, p90 42,
    // p95 51, p99 71), 55 bites the steepest few percent and leaves the ordinary
    // hillside alone. The first draft used 42, which sits at the p90 and sanded
    // the whole range: rms curvature at an 8 m lag fell by 47%, i.e. the knob
    // meant to add facets was the strongest smoother in the set.
    off: 55, on: 55, min: 20, max: 70, step: 1,
    needs: 'erode',
  },
  {
    key: 'snowJag',
    label: 'snow jag',
    hint: 'metres the snow line follows exposure -- ribs blow clear, hollows fill in',
    off: 0, on: 45, min: 0, max: 120, step: 2.5,
  },
  {
    key: 'crest',
    label: 'crest LOD',
    hint: 'coarse chunks bias toward the local max, so distant ridges keep their edge',
    off: 0, on: 1, min: 0, max: 1, step: 0.05,
  },
  {
    // DEAD CODE (peaks): off in RELIEF_SHIPPED; see the tag in chunk-mesh-v2.js.
    // A MESHER TERM, like `crest`, and the one that supersedes it: every vertex
    // of a chunk coarser than the texel takes the MAX of the field over the
    // footprint it owns, so no summit falls between samples and a peak never
    // grows as the ground under it re-splits -- it narrows. Ungated: valleys
    // narrower than a coarse cell fill at distance too, and that fill is why it
    // is opt-in rather than shipped: the point sample is nearer the ground over
    // the world as a whole. See PEAKS in chunk-mesh-v2.js.
    key: 'peaks',
    label: 'peak LOD',
    hint: 'a coarse chunk draws the max of the field over each vertex footprint, so a summit never grows as you approach',
    off: 0, on: 1, min: 0, max: 1, step: 1,
    integer: true,
  },
])

const BY_KEY = new Map(RELIEF_KNOBS.map((k) => [k.key, k]))

/** All knobs at their off value. Frozen: this object is shared, never mutated. */
export const RELIEF_DEFAULTS = Object.freeze(Object.fromEntries(RELIEF_KNOBS.map((k) => [k.key, k.off])))

/**
 * What the world BOOTS with. Not RELIEF_DEFAULTS: that object is the off state
 * the gate measures every knob against and stays the smooth, frozen field;
 * this is the configuration that ships, and main.js starts from it when no
 * saved relief overrides it.
 */
export const RELIEF_SHIPPED = Object.freeze({ ...RELIEF_DEFAULTS, jagged: 1 })

/**
 * Validate and clamp a relief object from anywhere -- the HUD, localStorage, a
 * postMessage. Returns a fresh frozen object with EVERY key present.
 *
 * Unknown keys THROW rather than being dropped. A relief that arrived over
 * postMessage with a misspelled key would otherwise be a knob that silently does
 * nothing, on one thread, which is exactly the class of bug this module exists
 * to make impossible.
 */
export function normalizeRelief(input) {
  if (input === undefined || input === null) return RELIEF_DEFAULTS
  if (typeof input !== 'object') throw new Error(`normalizeRelief: expected an object, got ${typeof input}`)
  for (const key of Object.keys(input)) {
    if (!BY_KEY.has(key)) throw new Error(`normalizeRelief: unknown relief knob '${key}' -- the knobs are ${RELIEF_KNOBS.map((k) => k.key).join(', ')}`)
  }
  const out = {}
  for (const knob of RELIEF_KNOBS) {
    const raw = input[knob.key]
    if (raw === undefined) {
      out[knob.key] = knob.off
      continue
    }
    if (!Number.isFinite(raw)) throw new Error(`normalizeRelief: ${knob.key} must be a finite number, got ${raw}`)
    const clamped = raw < knob.min ? knob.min : raw > knob.max ? knob.max : raw
    out[knob.key] = knob.integer ? Math.round(clamped) : clamped
  }
  return Object.freeze(out)
}

/** True when the relief changes nothing -- the assertion the gate rests on. */
export function reliefIsOff(relief) {
  return RELIEF_KNOBS.every((k) => k.needs !== undefined || relief[k.key] === k.off)
}

/** Value equality over the knob set, so a HUD tick that changes nothing does not remesh the world. */
export function sameRelief(a, b) {
  return RELIEF_KNOBS.every((k) => a[k.key] === b[k.key])
}

/**
 * Which of the expensive baked structures a relief actually needs.
 *
 * ExposureField costs a handful of full-field blurs and 1 MB resident; the
 * eroded copy costs a relaxation sweep and 4 MB; RidgeField costs a blur and a
 * Hessian per detection scale and 9 MB, and is shared by `ridge` and `shatter`. None is built unless some live knob
 * reads it, so an all-off world pays for nothing -- and `crest` and `snowJag`
 * are in the exposure list because both are gated on convexity even though the
 * `exposure` knob itself may be 0.
 */
export function reliefNeeds(relief) {
  return {
    exposure: relief.exposure > 0 || relief.crag > 0 || relief.snowJag > 0 || relief.crest > 0,
    erode: relief.erode > 0,
    crag: relief.crag > 0,
    ridge: relief.ridge > 0 || relief.shatter > 0,
    sharpen: relief.sharpen > 0,
  }
}
