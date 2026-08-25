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
// `talus` is the exception to "zero is off", and it is not a knob in the same
// sense: it is the repose angle the erosion pass relaxes toward, meaningless
// when `erode` is 0 and never read then. It carries `needs: 'erode'` so the HUD
// can grey it out and the gate can skip it in the all-off assertion.
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
])

const BY_KEY = new Map(RELIEF_KNOBS.map((k) => [k.key, k]))

/** All knobs at their off value. Frozen: this object is shared, never mutated. */
export const RELIEF_DEFAULTS = Object.freeze(Object.fromEntries(RELIEF_KNOBS.map((k) => [k.key, k.off])))

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
 * eroded copy costs a relaxation sweep and 4 MB. Neither is built unless some
 * live knob reads it, so an all-off world pays for nothing -- and `crest` and
 * `snowJag` are in the exposure list because both are gated on convexity even
 * though the `exposure` knob itself may be 0.
 */
export function reliefNeeds(relief) {
  return {
    exposure: relief.exposure > 0 || relief.crag > 0 || relief.snowJag > 0 || relief.crest > 0,
    erode: relief.erode > 0,
    crag: relief.crag > 0,
    sharpen: relief.sharpen > 0,
  }
}
