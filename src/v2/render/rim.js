import {
  setPropFadeTimerAt, setPropSolidAt, getPropClock, FADE_BAND, PROP_FADE_SECONDS,
} from '../../material.js'

// ---------------------------------------------------------------------------
// RIM: the outer dissolve, on a CLOCK rather than on the camera's distance.
//
// WHAT WAS WRONG WITH DISTANCE. The rim fade used to be a pure function of where
// the player stood: one gone-distance per instance, and the shader ran
// `1 - smoothstep(gone * FADE_BAND, gone, d)` against it. That costs no CPU at
// all, which is why it was built that way, and it has one steady state that
// nothing can fix from inside the shader -- A PROP PARKED IN ITS OWN FADE BAND
// IS PARKED IN A STIPPLE. Stand still and it dithers forever.
//
// AND IT IS NOT A RIM, WHICH IS THE PART THAT MAKES IT WORTH FIXING. The band
// looks like a thin shell at the draw radius and is nothing of the kind, because
// the thinning hands out gone-distances of `fullRadius / rank` with rank uniform
// on [0,1). At any distance d past fullRadius the instances still drawn are
// those with rank < fullRadius / d, and the ones inside their own band are those
// with rank in (FADE_BAND * fullRadius / d, fullRadius / d] -- a ratio of
// exactly 1 - FADE_BAND, independent of d. So a FIXED FIFTEEN PER CENT of every
// prop past fullRadius is permanently half-dissolved, at every distance from
// there to the horizon, not in a shell you could walk out of. That is the
// speckle over the whole far field, and it is why this is a correctness fix and
// not a polish pass.
//
// THE FIX IS THE MECHANISM THE LOD SWAP ALREADY USES. A cross-dissolve resolves
// because a clock drives it: stamp a start time into the instance's fade slot,
// let the shader turn `uPropClock - t0` into the ramp, and 250 ms later the
// transition is OVER and the prop is solid or gone. Applying the same clock to
// the rim makes the steady state binary -- every prop is either fully drawn or
// fully hidden, and a stipple is only ever a quarter second of transition.
// Nothing is permanently dithered anywhere, at any distance, at a standstill.
//
// WHAT IT COSTS is the thing the distance version was built to avoid: somebody
// has to notice the crossing, so there is a per-instance distance test per
// sweep. That is 5 ns an instance measured (grass's veil, which is this same
// scan and predates this file), amortised over RIM_PHASES frames, and it BUYS
// BACK more than it spends -- a prop past its dissolve is now set invisible
// rather than submitted and discarded fragment by fragment, which is the
// 13.9% of the grass bill the veil was already recovering, now recovered for
// every scatter instead of one.
//
// WHERE THE TRIGGER GOES, WHICH IS THE ONE NUMBER THIS HAD TO CHOOSE. The old
// band ran from `gone * FADE_BAND` to `gone` and a prop crossing it was drawn at
// falling coverage. A clock cannot do that -- it holds one distance and either
// keeps the prop or takes it -- so putting the trigger at either end of the band
// moves the population. MEASURED on the boot forest, 40,972 trees at the origin:
// 4,605 are past `gone` and 14,766 are past `gone * FADE_BAND`, so the band
// itself holds 10,161 trees, a QUARTER of the whole scatter. Triggering at
// FADE_BAND would hide all of them and thin the visible forest by 16%;
// triggering at `gone` would keep all of them and thicken it by as much.
//
// So the trigger is the MIDPOINT of the old band, and the reason is that the
// smoothstep is symmetric about it: a prop halfway across drew half its pixels,
// so a hard cut there keeps the same expected coverage the ramp did. The picture
// is the one that was there before, and it is now made of whole props.
//
// EVERYTHING ELSE STANDS UNCHANGED. `gone` still means the distance by which the
// prop is away, the trigger is still inside the old band, so RockBed's
// _fadeFloor still clears a rock's card distance (with more margin than it
// asked for, not less), the tile keep-fraction is still a conservative superset
// of the per-instance law, and the density-halves-as-distance-doubles taper is
// still the taper. Only the SHAPE of the ramp changed, from a function of where
// the camera is to a function of when it crossed.
//
// The one thing the clock cannot promise that the smoothstep could is that the
// prop is gone by exactly `gone`: a camera that covers the rest of the band
// inside PROP_FADE_SECONDS outruns the ramp. That needs `gone * (1 - RIM_AT)`
// metres in a quarter second, which is 21 m/s for a tuft of grass and 450 m/s
// for a tree, so it is reachable only by the litter bed at a hard fly -- and a
// camera moving that fast is outrunning the tile eviction too.
// ---------------------------------------------------------------------------

// Per-instance state. FRESH is 0 because Uint8Array starts there and because an
// instance that has never been drawn must not fade IN when it is first swept:
// its tile was just built, and a tile built inside the show boundary is the
// spawn/teleport case, where a quarter second of every prop in the world
// dithering up out of nothing is a worse picture than simply being there. FRESH
// resolves on its first sweep to SOLID or HIDDEN with no transition; every
// crossing after that is a fade. Keeping it per INSTANCE rather than as a flag
// on the tile is what makes a THICKENED tile behave -- it gains instances
// without losing the ones already mid-fade, and only the new ones snap.
const FRESH = 0
const SOLID = 1
const OUT = 2
const HIDDEN = 3
const IN = 4

// How many frames a full sweep of the resident set takes. Lifted from grass's
// veil, where the number was measured: eight phases is 133 ms of latency at
// 60 fps, being late to HIDE costs only the triangles the sweep was there to
// save, and being late to SHOW is bought off with slack rather than frequency.
export const RIM_PHASES = 8

// The fraction of an instance's gone-distance at which the rim takes it -- the
// midpoint of the band the shader's smoothstep used to run over, for the reason
// in the header. Exported because the debug readouts and the gates want to name
// the same distance the sweep does rather than restate the arithmetic.
export const RIM_AT = (1 + FADE_BAND) / 2

// Metres of slack at a standstill, and the decay on the speed estimate. Both are
// grass's, for grass's reasons: the floor covers a camera that is stationary
// while the scatter is rebuilt underneath it, and the decay holds the recent
// PEAK speed for about half a second so a player who accelerates hard is covered
// by the next frame rather than the next sweep.
const RIM_SLACK_MIN = 0.25
const RIM_SPEED_DECAY = 0.9

// The slack the BOUNDARIES use is quantised UP to a multiple of this, and that
// is what keeps a deceleration from being visible.
//
// The slack only ever DELAYS a hide, so every metre of it is holding a ring of
// props alive past their own boundary -- and the decay above gives that ring back
// a centimetre at a time over some forty frames. Each of those frames evicts the
// few props the boundary just passed, so a bed as dense as the blades retires a
// handful every frame for a second after the player has already stopped. Measured
// on the shipped blade bed, a 20 m walk then a standstill: 431 clumps over
// 1,069 ms, against the 361 ms of sweep-phase-plus-fade latency that is inherent.
//
// Rounding UP means the slack gives the same distance back in two or three jumps
// instead, so the churn ends with that latency rather than long after it. Up
// rather than down because the slack is a safety margin against a stale sweep:
// bigger is always sound, smaller is the thing that pops. A quarter metre is well
// under the RIM_HYST floor, so a step can never on its own carry a prop across
// both boundaries -- at half a metre it can, and check-trees catches it.
const RIM_SLACK_STEP = 0.25

// Separation between the distance a prop fades OUT at and the distance it is
// allowed to come back IN at: whichever is WIDER of a fixed 2 m and 7.5% of the
// prop's own gone-distance.
//
// THE FRACTION IS THE LOAD-BEARING HALF and the metres are only a floor under
// it. A prop's boundary is `gone * RIM_AT`, and `gone` runs from 8 m for a tuft
// of grass to 1,500 m for a tree, so a hysteresis in metres is a different
// promise at each end -- 2 m is a quarter of the grass boundary and a seventh of
// one per cent of the tree one. What toggles a prop is a distance change
// PROPORTIONAL to how far away it is: flying past a tree standing 80 m off its
// own rim moves it several metres in a second without the player going anywhere
// near it. Measured on the boot forest at a 60 m/s fly, a flat 2 m produced
// 1,935 trees that dissolved IN and then back OUT inside six seconds, 579 of
// which never got properly inside their own boundary at all -- a steady trickle
// of far foliage appearing and then thinking better of it, which is the artefact
// this number exists to prevent. With the fraction, and with the slack held off
// the show boundary below, those 579 are 62 at 60 m/s and none at 20; what is
// left is trees the player flew genuinely past, which SHOULD go.
//
// 7.5% IS NOT A TUNED NUMBER: it is `RIM_AT - FADE_BAND`, the inner half of the
// band the shader's smoothstep used to ramp over. So a prop still appears at the
// distance the old ramp reached full coverage at and still goes at the midpoint,
// and the population between those two distances is now whatever the player's
// own approach put there rather than a fixed answer.
//
// The metres floor is for the near scatters, where 7.5% is centimetres: it is
// over a third of a second of walking at 5 m/s, so head bob and a controller
// nudge cannot cross it.
//
// Both boundaries carry the slack, so the ordering `show < hide` holds at every
// speed and the separation stays exactly this.
export const RIM_HYST = 2
export const RIM_HYST_FRAC = RIM_AT - FADE_BAND

/**
 * The rim dissolve for one BatchedMesh: which instances are drawn, which are
 * hidden, and the quarter-second transitions between.
 *
 * Owned by a scatter, one per batch, and wired in four places -- `place` when an
 * instance is put down, `drop` when it is taken back, `beginFrame` once per
 * update, and `sweepTile` per tile in the loop the scatter already walks.
 */
export class RimFade {
  /**
   * `onPreempt` is called with an instance id an instant before the rim stamps a
   * transition onto it, and exists because there is ONE fade slot: a scatter
   * that also runs LOD cross-dissolves has to be told to retire the one it is
   * holding, or it keeps a duplicate alive against a start time that now
   * describes the rim's fade instead of its own. The rim wins that contest --
   * which LOD tier a prop was wearing on its way out is not a question anybody
   * is asking -- and `isBusy` is the other half of the deal, for the scatter to
   * check before starting a cross-dissolve of its own.
   */
  constructor(batch, maxInstances, onPreempt = null) {
    this.batch = batch
    this.onPreempt = onPreempt
    // The distance at which the instance is completely away. The shader no
    // longer reads this -- it lives here now, on the CPU, which is also what
    // makes it readable by a gate without decoding a texture.
    this.gone = new Float32Array(maxInstances)
    this.state = new Uint8Array(maxInstances)
    this.start = new Float32Array(maxInstances)

    // Fades in flight, dense, with an index back per instance so a scatter
    // reclaiming an instance mid-fade can pull it out in O(1). Same shape as the
    // cross-dissolve lists in rocks.js and grass.js, and for the same reason.
    this.flight = new Int32Array(maxInstances)
    this.flightAt = new Int32Array(maxInstances).fill(-1)
    this.flightN = 0

    this.phase = 0
    this.camLast = null
    this.camSpeed = 0
    this.slack = RIM_SLACK_MIN
    this.need = RIM_SLACK_MIN
    // How many resident instances are currently hidden by the rim. The scatter
    // reports it; it is also the number the triangle count has to leave out.
    this.hiddenCount = 0
  }

  /**
   * An instance has just been placed. `gone` is the distance at which it should
   * be completely away; the dissolve fires at RIM_AT of it.
   *
   * Starts hidden and FRESH rather than visible: the sweep decides, so there is
   * exactly one piece of code that knows where the boundary is. The scatter must
   * `markDue` the tile once it has one -- a tile object does not exist yet while
   * its instances are being placed -- or a freshly thickened tile is a hole in
   * the ground for up to RIM_PHASES frames.
   */
  place(id, gone) {
    this.gone[id] = gone
    this._unflight(id)
    this.state[id] = FRESH
    this.batch.setVisibleAt(id, false)
    setPropSolidAt(this.batch, id)
  }

  /** Sweep this tile on the next update whatever its phase says. */
  markDue(tile) {
    tile.rimDue = true
  }

  /**
   * A whole tile is being evicted. Takes its hidden instances out of the running
   * total -- `drop` cannot, because the count is kept per tile so that a sweep
   * can replace a tile's contribution rather than having to reason about which
   * individual instances changed since last time.
   */
  releaseTile(tile) {
    this.hiddenCount -= tile.rimHidden || 0
    tile.rimHidden = 0
    tile.rimDue = true
  }

  /**
   * An instance is going back to the pool. Clears its fade so the id can be
   * handed out again without carrying a stale transition into its next life.
   */
  drop(id) {
    this._unflight(id)
    this.state[id] = FRESH
  }

  /** Is this instance currently hidden by the rim, and so drawing nothing? */
  isHidden(id) {
    const s = this.state[id]
    return s === HIDDEN || s === FRESH
  }

  /** Is a rim transition in flight on this instance, and so is the slot spoken for? */
  isBusy(id) {
    const s = this.state[id]
    return s === OUT || s === IN
  }

  /**
   * Once per update, before the tile loop. Advances the sweep phase, re-measures
   * how fast the camera is travelling, and retires every transition whose window
   * is up -- retiring FIRST so a tile swept later this frame can re-trigger an
   * instance whose fade expired on this one.
   */
  beginFrame(camX, camY, camZ) {
    this.phase = (this.phase + 1) % RIM_PHASES
    if (this.camLast) {
      const moved = Math.hypot(
        camX - this.camLast[0], camY - this.camLast[1], camZ - this.camLast[2])
      this.camSpeed = Math.max(moved, this.camSpeed * RIM_SPEED_DECAY)
      // A decayed peak never reaches zero, so without this the slack keeps a
      // step's worth of props alive past their boundary forever after one walk.
      // Motion this small over a whole sweep is already inside the standing
      // floor, which is what the floor is for.
      if (this.camSpeed * RIM_PHASES < RIM_SLACK_MIN) this.camSpeed = 0
      this.camLast[0] = camX
      this.camLast[1] = camY
      this.camLast[2] = camZ
    } else {
      this.camLast = [camX, camY, camZ]
    }
    // Per FRAME rather than per second, because the sweep is counted in frames:
    // a slow frame widens the slack by exactly as much as it widens the
    // staleness it is covering for.
    //
    // TWO NUMBERS AND NOT ONE. `need` is the raw requirement and is what decides
    // a tile is DUE: a sweep has to be forced the instant the camera's motion
    // outgrows the decision a tile is holding, and quantising that test lets a
    // hard acceleration go up to RIM_PHASES frames without one -- 4 m of travel
    // at a sprint, which leaves props hidden well inside their own trigger.
    // `slack` is the rounded-up version and is what the BOUNDARIES use, which is
    // where a shrinking margin is visible. It is never smaller than `need`.
    this.need = RIM_SLACK_MIN + this.camSpeed * RIM_PHASES
    this.slack = RIM_SLACK_MIN
      + Math.ceil((this.camSpeed * RIM_PHASES) / RIM_SLACK_STEP) * RIM_SLACK_STEP
    this._retire(getPropClock())
  }

  /**
   * Sweep one tile if its turn has come up, and return how many of its instances
   * are hidden -- which is what the scatter has to leave out of its triangle
   * count. The tile carries its own phase, due flag and last-seen slack; they
   * are created here on first sight so a scatter needs no fields of its own.
   *
   * `instX/instY/instZ` are the scatter's per-instance position arrays. The rim
   * metric is plain distance to the instance origin in all seven scatters --
   * unlike the LOD bands, which squash or scale it per layer -- so this is the
   * one distance every caller agrees about.
   */
  sweepTile(tile, instX, instY, instZ, camX, camY, camZ) {
    if (tile.rimPhase === undefined) {
      // The phase is the TILE's own, derived from its coordinates rather than
      // taken from its position in the scatter's Map. Map order changes on every
      // evict and admit, so an index-derived phase lets a tile go many sweeps
      // without a turn -- which is exactly what the slack is sized against, and
      // it was measurably breaking it at speed. Both multipliers are coprime
      // with RIM_PHASES, so any run of tiles in either axis spreads evenly over
      // the phases instead of landing several rows on the same frame.
      tile.rimPhase = (((tile.tx * 5 + tile.tz * 3) % RIM_PHASES) + RIM_PHASES) % RIM_PHASES
      tile.rimDue = true
      tile.rimSlack = 0
      tile.rimHidden = 0
    }
    // A GROWING SLACK FORCES A SWEEP: instances hidden under a narrower slack
    // were hidden on a decision that stops being safe the moment the camera
    // speeds up, and without this a player going from a standstill to a sprint
    // outruns those decisions and the props pop in when the sweep catches up.
    // A shrinking slack needs nothing -- the old wider one is conservative.
    if (!(tile.rimDue || tile.rimPhase === this.phase || this.need > tile.rimSlack)) {
      return tile.rimHidden
    }

    const now = getPropClock()
    const slack = this.slack
    let hidden = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const ex = instX[id] - camX
      const ey = instY[id] - camY
      const ez = instZ[id] - camZ
      const d2 = ex * ex + ey * ey + ez * ez
      // Where the prop goes. The slack pushes BOTH boundaries out together, so
      // it delays a hide (costing triangles, which is what the sweep saves) and
      // brings a show forward (costing nothing, and buying off the only artefact
      // amortising can make).
      const from = this.gone[id] * RIM_AT + slack
      const state = this.state[id]

      if (state === FRESH) {
        // Never drawn. Resolve with no transition -- see FRESH.
        if (d2 < from * from) {
          this.state[id] = SOLID
          this.batch.setVisibleAt(id, true)
        } else {
          this.state[id] = HIDDEN
          hidden++
        }
        continue
      }

      if (state === SOLID) {
        if (d2 > from * from) this._startFade(id, now, false)
      } else if (state === HIDDEN) {
        // THE SLACK DOES NOT REACH THIS BOUNDARY, which is the other half of
        // never retracting a dissolve. The slack is there so a stale sweep
        // cannot hide a prop the camera has just closed on, and pushing the SHOW
        // boundary out with it admits props that are outside their own keep
        // radius: fly at 60 m/s and 6.9 m of slack shows several hundred trees
        // that belong to nobody, every one of which dissolves back out the
        // moment the camera slows and the slack decays. A prop appears when it
        // is genuinely inside its radius and never before.
        const back = Math.min(
          this.gone[id] * RIM_AT,
          from - Math.max(RIM_HYST, this.gone[id] * RIM_HYST_FRAC))
        if (d2 < back * back) {
          this.batch.setVisibleAt(id, true)
          this._startFade(id, now, true)
        } else {
          hidden++
        }
      }
      // OUT and IN are left alone. A transition runs to completion rather than
      // reversing: reversing means recovering the ramp position from the stamp
      // and re-deriving a start that preserves it, and what it would buy is the
      // one case where the camera turns round inside a quarter second of the
      // boundary -- where the honest answer, a prop that goes and comes back
      // over half a second, is a fair description of what the player just did.
      // RIM_HYST is what keeps that case rare.
    }
    tile.rimDue = false
    tile.rimSlack = this.need
    this.hiddenCount += hidden - tile.rimHidden
    tile.rimHidden = hidden
    return hidden
  }

  /**
   * Stamp one transition and put it in the flight list. The shader does the rest
   * until _retire takes it off.
   */
  _startFade(id, now, fadeIn) {
    if (this.onPreempt) this.onPreempt(id)
    setPropFadeTimerAt(this.batch, id, now, fadeIn)
    this.state[id] = fadeIn ? IN : OUT
    this.start[id] = now
    if (this.flightAt[id] < 0) {
      this.flightAt[id] = this.flightN
      this.flight[this.flightN++] = id
    }
  }

  /** Finish every transition whose window is up. Once per frame. */
  _retire(now) {
    let k = 0
    while (k < this.flightN) {
      const id = this.flight[k]
      const age = now - this.start[id]
      // Outside the window in EITHER direction. Negative means the prop clock
      // wrapped underneath this fade, which cannot be resumed and must not be
      // allowed to restart from zero -- a wrap would otherwise freeze every fade
      // in flight at its opening frame until the clock came back round.
      if (age < PROP_FADE_SECONDS && age >= 0) {
        k++
        continue
      }
      if (this.state[id] === OUT) {
        this.state[id] = HIDDEN
        this.batch.setVisibleAt(id, false)
      } else {
        this.state[id] = SOLID
      }
      // Whichever way it went, the slot goes back to the never-fade default: a
      // finished IN is solid, and a finished OUT is invisible, so the timer that
      // is still sitting there would only be a clock reading waiting to be
      // misread the next time this id is handed out.
      setPropSolidAt(this.batch, id)
      this._removeFlight(k)
    }
  }

  _unflight(id) {
    const k = this.flightAt[id]
    if (k >= 0) this._removeFlight(k)
  }

  /** Swap-remove, so the list stays dense and _retire stays a linear scan. */
  _removeFlight(k) {
    const id = this.flight[k]
    this.flightAt[id] = -1
    this.flightN--
    if (k < this.flightN) {
      const last = this.flight[this.flightN]
      this.flight[k] = last
      this.flightAt[last] = k
    }
  }

  /** For the debug panel and the gates. */
  stats() {
    return { hidden: this.hiddenCount, fading: this.flightN, slack: +this.slack.toFixed(2) }
  }
}
