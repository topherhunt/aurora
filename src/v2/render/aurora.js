// ---------------------------------------------------------------------------
// THE V2 AURORA: the shader lab's sky-map curtain, wired to the world clock.
//
// This replaces src/aurora.js for /v2 only. src/aurora.js is still what
// index.html draws and is not touched -- the two live side by side on purpose
// until v1 is retired, and this file deliberately mirrors its public surface
// (`mesh`, `update(head, state, elapsedReal)`, `cyclePattern`, `setPattern`,
// `label`, `blurb`, `dispose`) so main.js changes in two lines rather than ten.
//
// ===========================================================================
// WHAT IS ACTUALLY DIFFERENT
// ===========================================================================
//
// src/aurora.js draws BANDS: a few hundred quads swept along splines, each one
// a shape somebody described in a table. It is cheap and it is topologically
// incapable of the thing an aurora does -- a band cannot fork, braid or
// dissolve into rays, because it is one strip and a strip has two edges.
//
// This draws a FIELD: one ley-line potential evaluated over the plan, integrated
// along each view ray, and read off a dome. Forking and braiding are what the
// field does on its own; nothing enumerates them.
//
// The reason that is affordable is skymap/glsl.js, and it is worth one sentence
// here because it is the whole cost model. The field takes a PLAN position and
// no altitude, so every sample along one view ray lies on one ray from the plan
// origin, and in u = log(radius) the altitude window is a fixed width that
// merely translates as the ray tilts. That turns the per-pixel ray integral into
// a CONVOLUTION WITH A FIXED KERNEL along each azimuth row of a 512 x 64 buffer.
// The forty taps are paid on 32k texels once per frame instead of on every
// fragment of the sky, and a screen pixel costs one bilinear fetch.
//
// So the per-frame cost here is four small offscreen passes and a dome of 162
// triangles, and it is nearly independent of how much of the sky is in view.
// That is what makes a full dome affordable where the raymarching algorithms in
// the lab could only afford a northern sector.
//
// ===========================================================================
// WHAT THE CLOCK DRIVES, AND WHICH PART OF IT IS INVENTED
// ===========================================================================
//
// clock.js hands over two numbers. `state.aurora` is auroraMax * activity and is
// the brightness -- zero through the day, up to 1 at midnight in a storm. It
// drives `exposure` and nothing else, which is the honest place for it: exposure
// sits outside every modulation in the shader, so scaling it changes how bright
// the sky is and changes nothing about its structure.
//
// `state.activity` is the substorm envelope on [0.16, 1] and it drives SHAPE,
// through ACTIVITY_SHAPE below. That mapping is the one piece of invention in
// this file and it is physically motivated rather than measured: a substorm
// expands the auroral oval equatorward and widens it, and the display goes from
// a single quiet arc low on the northern horizon to rayed, braided structure
// filling the sky overhead. So rising activity pulls beltOffset toward the eye,
// widens beltWidth, lifts the floor under the belt (beltAmt down, meaning the
// southern sky stops being dark), and raises the striation and shimmer terms.
//
// The five ranges are one table rather than five scattered constants because
// they are one gesture, and every one of them passes through very near the
// lab's own schema default at about a = 0.4, which is where the clock's noise
// spends most of its time. Retune the table, not the call sites.
// ---------------------------------------------------------------------------

import { AuroraScreen } from '../../aurora-lab/screen.js'
import { SkyMapAurora } from '../../aurora-lab/skymap/skymap.js'
import { disposeSkyMap } from '../../aurora-lab/skymap/target.js'

// The registry id. Not a parameter: this file's whole cost argument is the
// convolution, and every other entry in the lab is a per-pixel raymarch that
// would put a forty-step loop on every fragment of a full dome.
const ALGORITHM = 'skymap'

// Final multiplier on top of state.aurora, and the one place to turn if the
// curtain reads dim or hot against v2's terrain. It is 1 because /v2 and
// /test-aurora share a colour pipeline exactly -- both are SRGBColorSpace out
// with no tone mapping -- so at state.aurora = 1 this is bit-for-bit the sky the
// lab shows at its defaults, and a number other than 1 here would mean the two
// pages had quietly stopped being comparable.
const BRIGHTNESS = 1.0

// Below this the mesh is hidden AND the four prepasses are skipped, which is
// what makes the whole system cost nothing at noon. Same threshold as
// src/aurora.js, so the hour at which the aurora appears does not shift.
const VISIBLE_AT = 0.004

// The clock's own bounds on state.activity. Read from clock.js rather than
// assumed: AURORA_ACTIVITY.quiet is the floor and .storm the ceiling, so
// normalising by them means a pinned pattern below is a real point on the
// clock's scale and not a number invented to look like one.
const ACT_LO = 0.16
const ACT_HI = 1.0

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
const ACTIVITY_SHAPE = {
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

// One key each, so the cycle is a cycle through the clock's own activity scale
// rather than through a table of hand-built forms. That is the difference this
// aurora is for: there are no forms, there is a field and a weather number.
const PATTERNS = [
  { name: 'quiet arc', activity: 0.16, blurb: 'one smooth band low on the northern horizon, which is what the sky does most nights' },
  { name: 'active bands', activity: 0.45, blurb: 'the oval has brightened and folded; several channels, rays starting to show' },
  { name: 'substorm breakup', activity: 0.75, blurb: 'the oval has expanded south and shattered into rayed structure overhead' },
  { name: 'full storm', activity: 1.0, blurb: 'the whole sky is lit, braided and shimmering from horizon to zenith' },
]

function lerp( a, b, t ) {
  return a + ( b - a ) * t
}

// ---------------------------------------------------------------------------

export class SkyAurora {
  // `renderer` is REQUIRED and there is no fallback, because the four prepasses
  // are renders and a missing renderer would otherwise show up as a sky that is
  // simply black -- the failure mode this lab has already paid for twice.
  constructor( scene, { renderer, seed = 0 } = {} ) {
    if ( !renderer ) throw new Error( 'SkyAurora: needs the WebGLRenderer -- the sky map is built by rendering' )

    this.screen = new AuroraScreen( scene, { algorithm: ALGORITHM } )
    this.skymap = new SkyMapAurora( renderer )

    // The lab's field-seed knob, which offsets every algorithm in the plan and
    // changes nothing about the look. 0..100 in steps of 1 per its schema, so
    // the world seed is folded into that range rather than written raw.
    this.screen.setParam( 'fieldSeed', ( ( seed % 101 ) + 101 ) % 101 )

    // -1 is auto, 0..N-1 pin one of PATTERNS. Same convention as
    // src/aurora.js so cycleAurora() in main.js needs no changes.
    this.pattern = -1

    // What update() last resolved, for the HUD. Held rather than recomputed
    // because `label` is read from a console line that must say what was
    // actually drawn, not what would be drawn if it were asked again.
    this._activity = ACT_LO
    this._visible = false

    this.mesh = this.screen.mesh
  }

  // -------------------------------------------------------------------------

  cyclePattern( dir = 1 ) {
    const n = PATTERNS.length + 1
    this.pattern = ( ( ( this.pattern + 1 + dir ) % n ) + n ) % n - 1
    return this.pattern
  }

  setPattern( i ) {
    if ( !( i >= -1 && i < PATTERNS.length ) ) throw new Error( `no aurora pattern ${i}` )
    this.pattern = i
    return this.pattern
  }

  // What the console line prints. In auto it reports the activity that was
  // actually used and the band it falls in, which is the only way to tell a
  // quiet night from a broken clock.
  get label() {
    if ( this.pattern >= 0 ) return `[${this.pattern + 1}/${PATTERNS.length}] ${PATTERNS[ this.pattern ].name} -- pinned`
    if ( !this._visible ) return 'auto -- nothing up'
    return `auto -- ${this._nearest().name} ${this._activity.toFixed( 2 )}`
  }

  get blurb() {
    if ( this.pattern >= 0 ) return PATTERNS[ this.pattern ].blurb
    return this._visible ? this._nearest().blurb : ''
  }

  // The named band this activity is closest to. Purely a naming device: nothing
  // in the shader is quantised to these four, the shape table is continuous.
  _nearest() {
    let best = PATTERNS[ 0 ]
    let d = Infinity
    for ( const p of PATTERNS ) {
      const e = Math.abs( p.activity - this._activity )
      if ( e < d ) {
        d = e
        best = p
      }
    }
    return best
  }

  // -------------------------------------------------------------------------

  // `head` is her world position, `state` the clock state, `elapsedReal` real
  // seconds since start.
  //
  // The animation clock is REAL seconds for the same reason src/aurora.js gives:
  // the curtain should shimmer at the speed a real aurora shimmers however fast
  // the day is running, and a time skip must not fast-forward six minutes of
  // writhing into one frame. What the skip DOES move is state.activity, which
  // is on in-world hours -- so skipping changes the weather and not the motion.
  update( head, state, elapsedReal ) {
    const i = state.aurora
    this._visible = i > VISIBLE_AT
    this.mesh.visible = this._visible

    // The early return is the point of the threshold. Everything below it is a
    // render, so a daytime frame pays one comparison for the whole subsystem.
    if ( !this._visible ) return

    this._activity = this.pattern >= 0 ? PATTERNS[ this.pattern ].activity : state.activity

    const a = ( this._activity - ACT_LO ) / ( ACT_HI - ACT_LO )
    for ( const key of Object.keys( ACTIVITY_SHAPE ) ) {
      const range = ACTIVITY_SHAPE[ key ]
      this.screen.setParam( key, lerp( range[ 0 ], range[ 1 ], a ) )
    }
    this.screen.setParam( 'exposure', i * BRIGHTNESS )

    // ORDER MATTERS, in both directions.
    //
    // setParam writes this.screen.values, and render() reads that object by
    // reference -- so the writes above have to land first or the map is built
    // from last frame's weather.
    //
    // And render() must be handed the SAME time screen.update gets. A mismatch
    // does not error: it renders the map from a different instant than the frame
    // that reads it, which looks like the aurora lagging its own controls. See
    // the note at the top of skymap/skymap.js.
    //
    // This is called from applySky, which runs before both probes and before the
    // main render, so the map is always fresh by the time anything samples it --
    // including SkyProbe, which captures this mesh into the cubemap the water
    // reflects.
    this.skymap.render( ALGORITHM, this.screen.values, elapsedReal )
    this.screen.update( head, elapsedReal )
  }

  dispose() {
    this.screen.dispose()
    this.skymap.dispose()
    // Safe HERE and nowhere else. The four maps are module singletons that the
    // screen's material holds; skymap/target.js explains at length why freeing
    // them from an instance teardown is a use-after-free. The screen is gone one
    // line above, so this is the page teardown that call is waiting for.
    disposeSkyMap()
  }
}
