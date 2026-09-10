// ---------------------------------------------------------------------------
// WHAT THE WORLD DOES TO THE LAB'S KNOBS.
//
// The lab and /v2 draw the same sky with the same code: one AuroraScreen, one
// SkyMapAurora, one schema. The only thing that has ever differed between them
// is WHICH VALUES those knobs are holding, and that difference lived entirely
// inside v2/render/aurora.js -- so the bench you tuned on and the world you
// looked at were two different skies with no way to tell by how much.
//
// This module is that difference, extracted, so both pages import it and there
// is one table rather than two that drift. /v2 drives it from clock.js;
// /test-aurora drives it from two sliders that stand in for the clock. Same
// numbers in, same sky out.
//
// ===========================================================================
// THE CLOCK HANDS OVER TWO NUMBERS AND THAT IS THE WHOLE SEAM
// ===========================================================================
//
// `state.aurora` is auroraMax * activity: zero through the day, 1 at midnight in
// a storm. It drives `exposure` and nothing else, which is the honest place for
// it -- exposure sits outside every modulation in the shader, so scaling it
// changes how bright the sky is and changes nothing about its structure.
//
// `state.activity` is the substorm envelope on [ACT_LO, ACT_HI] and it drives
// SHAPE, through ACTIVITY_SHAPE. That mapping is the one piece of invention
// here and it is physically motivated rather than measured: a substorm expands
// the auroral oval equatorward and widens it, and the display goes from a single
// quiet arc low on the northern horizon to rayed, braided structure filling the
// sky overhead. So rising activity pulls beltOffset toward the eye, widens
// beltWidth, lifts the floor under the belt (beltAmt down, meaning the southern
// sky stops being dark), and raises the striation and shimmer terms.
//
// The five ranges are one table rather than five scattered constants because
// they are one gesture, and every one of them passes through very near the
// schema default at about a = 0.4, which is where the clock's noise spends most
// of its time. Retune the table, not the call sites -- and note that tuning a
// belt slider in the lab with the drive ON tunes nothing durable, because the
// next frame in the world overwrites it from here.
// ---------------------------------------------------------------------------

// The registry id the world draws. Not a parameter: v2's whole cost argument is
// the convolution, and every other entry in the lab is a per-pixel raymarch that
// would put a forty-step loop on every fragment of a full dome.
export const WORLD_ALGORITHM = 'skymap'

// Final multiplier on top of state.aurora, and the one place to turn if the
// curtain reads dim or hot against v2's terrain. It is 1 because /v2 and
// /test-aurora share a colour pipeline exactly -- both are SRGBColorSpace out
// with no tone mapping -- so at state.aurora = 1 the two pages are bit-for-bit
// the same sky, and a number other than 1 here would mean they had quietly
// stopped being comparable.
export const BRIGHTNESS = 1.0

// Below this /v2 hides the mesh AND skips the four prepasses, which is what
// makes the whole system cost nothing at noon.
export const VISIBLE_AT = 0.004

// The clock's own bounds on state.activity. These are AURORA_ACTIVITY.quiet and
// .storm from clock.js, restated rather than imported because clock.js is a v2
// module and this one is under the lab -- the gate in check-aurora-lab.mjs is
// what keeps the two in step.
export const ACT_LO = 0.16
export const ACT_HI = 1.0

// [ at quiet, at storm ]. See the header for why these five and not others.
//
// The two belt numbers are in kilometres and they are bounded by geometry
// rather than by taste, which is worth writing down because it is not obvious
// from the sliders. At persp 0.78 and the schema's 77-174 km emitting layer, the
// WHOLE visible sky maps to plan radii of about 0 to 700 km: a ray 45 degrees up
// samples 71 to 160 km out, a ray at 10 degrees samples 213 to 482, and a ray on
// the horizon samples 311 to 703. So an oval centred 640 km out is on the
// northern horizon and one centred 200 km out is overhead -- and, because the
// mapping is symmetric in azimuth, an oval wide enough to fill the zenith also
// reaches into the SOUTHERN sky at the same radius. That is real (a big storm
// genuinely does put aurora past the zenith) but it is easy to overshoot into a
// sky that is brighter behind you than in front, which is the one failure this
// geometry makes easy.
//
// The storm end is therefore swept rather than chosen. Mean screen brightness
// facing north over mean facing south, averaged over four instants at a = 1.0
// (swept on a real WebGL2 context under headless Chrome and SwiftShader):
//
//     belt  width  amt 0.66   amt 0.80
//     -260    620      0.98       1.03
//     -360    560      1.10       1.20
//     -460    500      1.22       1.45
//     -560    440      1.23       1.57
//
// Two things to read off that table. The oval's DISTANCE is the weaker lever and
// it costs northern brightness directly (north falls 31.2 to 26.4 down the amt
// 0.66 column), because pulling the oval out moves it off the zenith. beltAmt is
// the stronger one and it is nearly free: at -460 going 0.66 to 0.80 takes the
// ratio 1.22 to 1.45 while the north only dims 29.4 to 28.9, since a deeper
// floor cut darkens the sky AWAY from the belt and the belt is where the north
// already is. So the storm end takes most of its bias from amt and stops pulling
// the oval out early, at -440 / 520 / 0.78, between the two measured rows.
export const ACTIVITY_SHAPE = {
  // Plan z of the centre of the oval. Negative because -z is north. A quiet oval
  // sits far away and low on the horizon; a storm brings it nearly overhead.
  beltOffset: [ -620, -440 ],
  // How far the oval reaches to either side of that centre.
  beltWidth: [ 300, 520 ],
  // How dark the sky gets away from the oval. 0.93 leaves the rest of the sky at
  // seven percent, which is a quiet night with one arc in it; 0.78 leaves it at
  // twenty-two, which is a storm lighting the whole sky but still lighting the
  // north more.
  beltAmt: [ 0.93, 0.78 ],
  // The vertical striations. Real quiet arcs are smooth; rays are what a
  // breakup looks like.
  rays: [ 0.34, 0.92 ],
  // The interference shimmer travelling along the channels.
  caustic: [ 0.30, 0.85 ],
}

// The keys ACTIVITY_SHAPE drives, plus the one `exposure` drives. Exported so
// the lab can grey out exactly the rows the drive owns rather than keeping its
// own list of them.
export const DRIVEN_KEYS = [ ...Object.keys( ACTIVITY_SHAPE ), 'exposure' ]

// One key each, so the cycle is a cycle through the clock's own activity scale
// rather than through a table of hand-built forms. That is the difference this
// aurora is for: there are no forms, there is a field and a weather number.
export const PATTERNS = [
  { name: 'quiet arc', activity: 0.16, blurb: 'one smooth band low on the northern horizon, which is what the sky does most nights' },
  { name: 'active bands', activity: 0.45, blurb: 'the oval has brightened and folded; several channels, rays starting to show' },
  { name: 'substorm breakup', activity: 0.75, blurb: 'the oval has expanded south and shattered into rayed structure overhead' },
  { name: 'full storm', activity: 1.0, blurb: 'the whole sky is lit, braided and shimmering from horizon to zenith' },
]

function lerp( a, b, t ) {
  return a + ( b - a ) * t
}

/**
 * The six schema values the world holds at one instant of its clock.
 *
 * `activity` is state.activity, `aurora` is state.aurora. Returns a plain
 * `{key: value}` over DRIVEN_KEYS, ready to be pushed straight at setParam --
 * both callers want exactly that and neither wants the other's plumbing.
 *
 * `activity` is NOT clamped. Out of range is a caller passing something that is
 * not the clock's envelope, and extrapolating the table silently is how the lab
 * ends up showing a sky the world cannot reach.
 */
export function worldDrivenValues( activity, aurora ) {
  if ( !Number.isFinite( activity ) ) throw new Error( 'worldDrivenValues: activity must be finite, got ' + activity )
  if ( !Number.isFinite( aurora ) ) throw new Error( 'worldDrivenValues: aurora must be finite, got ' + aurora )

  const a = ( activity - ACT_LO ) / ( ACT_HI - ACT_LO )
  const out = {}
  for ( const key of Object.keys( ACTIVITY_SHAPE ) ) {
    const range = ACTIVITY_SHAPE[ key ]
    out[ key ] = lerp( range[ 0 ], range[ 1 ], a )
  }
  out.exposure = aurora * BRIGHTNESS
  return out
}

/**
 * The world seed folded into the `fieldSeed` slider's 0..100.
 *
 * That knob offsets every algorithm in the plan and changes nothing about the
 * look, but it decides WHICH channels you are looking at -- so the lab has to
 * fold the same seed the same way or it is tuning a different piece of sky.
 */
export function worldFieldSeed( seed ) {
  if ( !Number.isInteger( seed ) ) throw new Error( 'worldFieldSeed: needs an integer seed, got ' + seed )
  return ( ( seed % 101 ) + 101 ) % 101
}

// The named band an activity is closest to. Purely a naming device: nothing in
// the shader is quantised to these four, the shape table is continuous.
export function nearestPattern( activity ) {
  let best = PATTERNS[ 0 ]
  let d = Infinity
  for ( const p of PATTERNS ) {
    const e = Math.abs( p.activity - activity )
    if ( e < d ) {
      d = e
      best = p
    }
  }
  return best
}
