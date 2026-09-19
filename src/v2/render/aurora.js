// ---------------------------------------------------------------------------
// THE V2 AURORA: the shader lab's sky-map curtain, wired to the world clock.
//
// This is the aurora the world draws. It replaced the band mesh now parked in
// archive/aurora-mesh/aurora.js, which nothing loads -- see archive/README.md
// for the Quest measurement that decides whether that one comes back. This file
// still mirrors its public surface (`mesh`, `update(head, state, elapsedReal)`,
// `cyclePattern`, `setPattern`, `label`, `blurb`, `dispose`), which is what
// keeps swapping them a two-line change in main.js.
//
// ===========================================================================
// WHAT IS ACTUALLY DIFFERENT
// ===========================================================================
//
// The archived mesh draws BANDS: a few hundred quads swept along splines, each
// one a shape somebody described in a table. It is cheap and it is topologically
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
// So a rebuild of the map is four small offscreen passes, nearly independent of
// how much of the sky is in view, and the dome is 198 triangles at two bilinear
// fetches a pixel. That is what makes a full dome affordable where the
// raymarching algorithms in the lab could only afford a northern sector.
//
// The world does not rebuild the map every frame. Measured on a forested
// lakeshore at night the four passes cost 12 fps (50 against 62), so the map is
// rebuilt once per MAP_INTERVALS[0] seconds, one pass per frame, and the dome
// blends the three newest maps, each fading in and out over three intervals --
// see THE SCHEDULE in skymap/skymap.js. cycleInterval walks the other entries
// for the debug menu.
//
// ===========================================================================
// WHERE THE TUNING LIVES, AND WHY IT IS NOT IN THIS FILE
// ===========================================================================
//
// Every number that turns the clock's two outputs into schema values is in
// aurora-lab/world-drive.js, not here, because /test-aurora imports the same
// module and stands the same sky up on a monitor. This file is the wiring: it
// reads clock state, hands the two numbers over, and pushes the result at the
// screen. Retune world-drive.js -- both pages move together, and the gate in
// check-aurora-lab.mjs fails if one of them stops asking.
// ---------------------------------------------------------------------------

import { AuroraScreen } from '../../aurora-lab/screen.js'
import { SkyMapAurora } from '../../aurora-lab/skymap/skymap.js'
import { disposeSkyMap } from '../../aurora-lab/skymap/target.js'
import {
  WORLD_ALGORITHM, VISIBLE_AT, ACT_LO, PATTERNS,
  worldDrivenValues, worldFieldSeed, nearestPattern,
} from '../../aurora-lab/world-drive.js'

// ---------------------------------------------------------------------------

// Seconds between rebuilds of the sky map, in the order the debug row cycles them. The first is what the world ships at.
export const MAP_INTERVALS = [ 1, 2, 4, 0.5 ]

export class SkyAurora {
  // `renderer` is REQUIRED and there is no fallback, because the four prepasses
  // are renders and a missing renderer would otherwise show up as a sky that is
  // simply black -- the failure mode this lab has already paid for twice.
  constructor( scene, { renderer, seed = 0 } = {} ) {
    if ( !renderer ) throw new Error( 'SkyAurora: needs the WebGLRenderer -- the sky map is built by rendering' )

    this.screen = new AuroraScreen( scene, { algorithm: WORLD_ALGORITHM } )
    this.skymap = new SkyMapAurora( renderer )
    this.skymap.interval = MAP_INTERVALS[ 0 ]

    // The lab's field-seed knob. The fold lives in world-drive.js so that
    // /test-aurora can apply the same one to the same SEED and be looking at
    // the same piece of sky.
    this.screen.setParam( 'fieldSeed', worldFieldSeed( seed ) )

    // -1 is auto, 0..N-1 pin one of PATTERNS. Same convention as
    // the archived band mesh, so cycleAurora() in main.js needs no changes.
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

  _nearest() {
    return nearestPattern( this._activity )
  }

  get interval() {
    return this.skymap.interval
  }

  cycleInterval() {
    const i = MAP_INTERVALS.indexOf( this.skymap.interval )
    if ( i < 0 ) throw new Error( `aurora map interval ${this.skymap.interval} is not in MAP_INTERVALS` )
    this.skymap.interval = MAP_INTERVALS[ ( i + 1 ) % MAP_INTERVALS.length ]
    return this.skymap.interval
  }

  // -------------------------------------------------------------------------

  // `head` is her world position, `state` the clock state, `elapsedReal` real
  // seconds since start.
  //
  // The animation clock is REAL seconds for the same reason the band mesh gives:
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

    // The six values the world holds at this instant. Same call /test-aurora
    // makes from its two sliders, which is what makes the bench trustworthy.
    const driven = worldDrivenValues( this._activity, i )
    for ( const key of Object.keys( driven ) ) this.screen.setParam( key, driven[ key ] )

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
    this.skymap.render( WORLD_ALGORITHM, this.screen.values, elapsedReal )
    this.screen.setSkyWeights( this.skymap.weights )
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
