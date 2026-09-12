/**
 * WORLD PROBE -- the land, captured so the water can reflect and refract it.
 *
 * WHAT THIS IS FOR, AND WHY IT IS A SEPARATE THING FROM sky-probe.js
 *
 * The water already answers "what is the sky along this ray" analytically and
 * "what is the aurora along this ray" from a 64 px additive capture. What it
 * could not answer was "what is the LAND along this ray", and its stand-in was
 * the terrain horizon map: 16 azimuths of "how high does the ground rise this
 * way", mixed to one flat slate blue. That is a decent silhouette for a mountain
 * a kilometre off and nothing at all for the spruce standing on the bank two
 * metres away, because trees are not in a terrain horizon map and never will be.
 *
 * So this captures the world itself. Same shape as the sky probe -- a cube
 * target, one face per update -- and three deliberate differences:
 *
 *   1. It captures LAYER 0, the ordinary scene, rather than a private layer.
 *      There is no "the world" layer to point at, and the layer trap in
 *      sky-probe.js forbids inventing one.
 *   2. It has a DEPTH BUFFER. The aurora is additive and cannot occlude itself;
 *      a hillside in front of a tree very much can.
 *   3. Its ALPHA is the payload as much as its colour. The target clears to
 *      transparent black, so alpha comes back 1 where geometry covered the
 *      pixel, 0 where the ray went out to sky, and a leaf's own alpha at the
 *      soft edge of a billboard card. That is a strictly better version of the
 *      number wlBlocked was returning, so water.js takes the max of the two:
 *      whichever says "land", it is land, and the capture supplies the actual
 *      colour where it has one.
 *
 * WHAT IS HIDDEN DURING THE CAPTURE, and each one is a bug if you forget it:
 *
 *   - the water itself, or the reflection contains a 128 px reflection
 *   - the sky dome, which would fill every face with alpha 1 and turn "is there
 *     land here" into "yes, always"
 *   - scene.background, which does the same thing more quietly
 *   - the aurora and the stars, which the sky probe already carries and which
 *     would otherwise be added to the water twice
 *
 * PARALLAX, WHICH IS THE HONEST LIMITATION
 *
 * A cube capture is correct from exactly one point. The sky probe gets away with
 * reusing one for a hundred metres of walking because its subjects are 5-17 km
 * out; this one's subjects are on the bank. A tree five metres away, seen in a
 * capture taken ten metres ago, is simply in the wrong place. There is no fixing
 * that short of capturing per-pixel, which is a raytracer.
 *
 * What makes it acceptable is what it is FOR: a rippling surface at a grazing
 * angle, distorted by a wave normal that is itself moving several metres a
 * second, seen either across a lake or through a metre of murk. Nothing in that
 * description survives being off by a few degrees. It reads as "the bank is
 * over there and it is green", which is the whole ask.
 *
 * So the refresh policy is built around movement rather than time. Standing
 * still, the world is static apart from the light, and this ticks over slowly
 * enough to be free. Walk far enough for the parallax to matter and it re-anchors
 * and refills every face back-to-back. See REFRESH below.
 *
 * WHERE IT IS CAPTURED FROM: 20 cm above the water, OUT ON THE WATER when the
 * host can find some within reach (see setVantage), else at her own x/z. Not at
 * the head: a capture taken two metres up and then sampled by a surface at water
 * level puts the horizon in the wrong place, and the horizon is the one feature
 * a grazing reflection is entirely made of. And not on the bank: a capture
 * taken beside a trunk on the shore is a reflection with that trunk across it.
 */
import THREE from './three-instance.js'

const scratchColor = new THREE.Color()

export const WORLD_PROBE = {
  // Per face. Four times the sky probe's, and it still is not much -- but the
  // sky probe carries a soft gradient and this carries a treeline. Past 128 the
  // cost is real (each face is a scene traversal) and the gain is not: the
  // sampler on the other end is a wave normal wobbling by several degrees.
  size: 128,

  // 20 cm above the surface, as opposed to at it. Exactly at the surface puts
  // the capture point in the plane of the thing sampling it, where half the
  // faces see the water plane edge-on and the numerically-flat cases live.
  height: 0.2,

  // THE FLOOR UNDER THAT, in metres below her eye, and it is what stops the
  // capture being taken from INSIDE A HILLSIDE.
  //
  // `levelAt` is a yes/no test on the water POLYGON, not a nearest-water query:
  // standing at the edge of a lake it answers with the lake's still level while
  // the ground under her feet is metres higher, because the lake mask is
  // dilated a cell so its polygon edge can be buried under the bank. Anchoring
  // at `lakeLevel + height` there puts the camera underground with a 0.3 m near
  // plane, and every face it captures is filled by whatever card, strip or rock
  // happens to be within arm's reach -- the "giant grey blobs" a lake shore was
  // reflecting, which a river never showed because a river's level sits close to
  // the ground beside it.
  //
  // Her eye is the one point in the world guaranteed to be above the ground, so
  // the anchor is never allowed further below it than this. 1.2 m against a
  // 1.65 m eye leaves the capture around knee height when she is out of the
  // water -- well clear of the ground and still 1.2 m nearer the water than her
  // head. Whenever she is IN the water her eye is at or below the surface, so
  // this floor is under `surfaceY + height` and the max picks the surface, which
  // is the case the surface offset was written for in the first place.
  //
  // Only the FALLBACK rule reads this. When the host's vantage finds water
  // within reach the capture goes out onto it, at `level + height` over ground
  // it has checked is under the surface, and no floor is needed.
  duck: 1.2,

  // Frames between faces while she is standing still. Five faces to go round, so
  // a full refresh is this times five: 150 frames, about 2 s at 72 Hz. Slow on
  // purpose -- what changes on that timescale is the light, not the land.
  everyNFrames: 30,

  // How far she can move from the anchor before the capture is re-taken from
  // where she is now, in metres. Crossing it refills all five faces on
  // consecutive frames rather than over the next two seconds, because the case
  // this exists for is walking along a river bank, where the whole reflection is
  // wrong until it catches up.
  moveRefresh: 12,

  // Seconds to cross-fade a freshly-taken cube over the one it replaces.
  //
  // The slow one-face-every-30-frames refresh is invisible: same anchor, and
  // only the light has moved. A RE-ANCHOR is not, because five faces change at
  // once and the whole reflection cuts to a different vantage point in a single
  // frame. So the probe keeps two cubes and ping-pongs: the new one is filled
  // into the target that is not currently being displayed, and only once all
  // five faces are in does the shader begin mixing toward it.
  //
  // A re-anchor is REFUSED while a fill or a fade is still running, which is
  // what keeps this from degenerating during fast flight. Crossing 12 m every
  // half second would otherwise queue transitions faster than they can finish
  // and every one of them would end in a snap; deferring instead rate-limits
  // the whole thing to one smooth handover per ~1.1 s and lets the cube go
  // staler in between. That is the trade this feature was given permission to
  // make -- a stale reflection that slides is better than a fresh one that cuts.
  fadeSeconds: 1.0,

  // Scales the captured coverage before the water uses it. 1.0 trusts the
  // capture completely; lower fades it back toward the flat slate silhouette the
  // horizon map alone gives, which is what to reach for if the parallax error
  // ever reads as worse than the thing it replaced.
  mix: 1.0,
}

// +X, -X, +Y, -Y, +Z, -Z, the cube face order WebGLCubeRenderTarget uses. -Y is
// index 3 and is left out for the same reason the sky probe leaves it out: both
// of water.js's paths fold their ray into the upper hemisphere before sampling,
// so nothing ever reads it. It is a fifth of the cost for a face that is, in any
// case, the riverbed seen from the surface -- which the water's own body colour
// is already standing in for.
const FACES = [0, 1, 2, 4, 5]

/** One cube target. Two of these exist so a new capture can be faded in over
 *  the one it replaces rather than cutting to it. */
function makeTarget() {
  return new THREE.WebGLCubeRenderTarget(WORLD_PROBE.size, {
      // Half float rather than a byte, and the reason is the same one that put
      // the terrain in linear space: what is written here is LINEAR light, not
      // display-encoded colour, so the bottom of the range is where all the
      // precision needs to be. Eight linear bits puts visible banding across
      // every shadowed hillside, which is most of what this captures at night.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      // Unlike the sky probe: a hill in front of a tree has to win.
    depthBuffer: true,
  })
}

export class WorldProbe {
  constructor() {
    // TWO cubes, ping-ponged. `a` and `b` are handed to the shader once at
    // construction and never reassigned -- what moves is `fade`, a single float,
    // which is the whole reason this is a ping-pong rather than a swap of which
    // texture the uniform points at.
    this.a = makeTarget()
    this.b = makeTarget()
    this.textureA = this.a.texture
    this.textureB = this.b.texture

    // 0 means the shader is showing A, 1 means B, in between is a cross-fade.
    this.fade = 0
    // Which cube is fully live, and therefore which one the slow same-anchor
    // refresh is allowed to touch. Equals `fade` whenever nothing is in flight.
    this.live = 0
    // The cube being burst-filled, or -1 when nothing is. Never equals `live`.
    this.filling = -1
    // Whether each cube has ever held a complete capture. The first one in has
    // nothing to fade FROM, so it snaps.
    this.everFilled = [false, false]

    // near is 30 cm rather than the sky probe's 1 m: the capture point is 20 cm
    // off the water and a bank can come right up to it. far is the sky probe's,
    // which brackets the furthest terrain the world can draw.
    //
    // The rig carries no render target of its own -- every render here names the
    // target and the face explicitly, because which of the two cubes is being
    // written changes from one burst to the next.
    this.rig = new THREE.CubeCamera(0.3, 30000, this.a)

    // Left on layer 0 -- the ordinary scene, which is the entire point. What is
    // excluded is excluded by visibility, below, not by layer.

    this.face = 0
    this.frame = 0
    this.captures = 0

    // Where the current cube was taken from.
    this.anchor = new THREE.Vector3()
    // Where HER HEAD was when it was taken, which is what moveRefresh measures
    // against: the anchor may sit metres out on the water, and measuring from
    // there would re-anchor after a step. Starts absurd so the first update
    // always anchors.
    this.origin = new THREE.Vector3(Infinity, Infinity, Infinity)

    // Faces still owed on the cube being filled. Counted down one per frame.
    this.burst = 0

    // Objects hidden for the duration of every capture. See the header.
    this.hidden = []

    // See setVantage.
    this.vantage = null
  }

  /**
   * `fn(head, out)` picks the capture point at each re-anchor: fill `out` with
   * it and return true, or return false to fall back to her own x/z under the
   * duck rule in update(). The host owns the terrain and the water polygons, so
   * "a couple of metres out on the water" is its question to answer; called
   * only when a re-anchor actually happens, so it may afford a few dozen height
   * samples.
   */
  setVantage(fn) {
    if (typeof fn !== 'function') throw new Error('WorldProbe.setVantage needs a (head, out) => boolean')
    this.vantage = fn
  }

  /** Register something that must not appear in the capture. Order does not
   *  matter and duplicates are harmless; each is restored to whatever visibility
   *  it actually had, not to true. */
  exclude(...objects) {
    for (const o of objects) {
      if (!o) throw new Error('WorldProbe.exclude: given nothing to exclude')
      this.hidden.push(o)
    }
  }

  /**
   * One face, or nothing, plus a step of the cross-fade. Call once per frame
   * BEFORE the main render, for the same reason the sky probe insists on it:
   * this binds a render target and leaves it unbound, and doing that after the
   * XR framebuffer is set up draws the frame into the wrong buffer.
   *
   * `surfaceY` is the level of the water she is at or nearest to, or null where
   * there is none. See WORLD_PROBE.duck for why it is a floor rather than the
   * answer: the polygon test that produces it says the lake's level while she
   * stands on a bank metres above it, and taking that literally buries the
   * camera in the hillside.
   *
   * `dt` is real seconds, already clamped by the caller, and drives the fade
   * only. Everything else here counts frames, because everything else here is
   * rationing GPU work rather than animating.
   */
  /**
   * `air`, when given, is a pair of closures the host uses to lend the capture
   * an atmosphere different from the one the frame is being drawn with. It
   * exists for exactly one case: swimming. The capture is anchored just ABOVE
   * the surface -- in air -- but it runs inside a frame whose fog, lights and
   * aerial ramp have already been sunk to the murk, so without it the cube
   * comes back with a 20 m haze ceiling and grey, murk-tinted props, and that
   * cube is what the underside of the surface is shaded from. The murk would
   * arrive on the sky she is looking up at through the water, twice over.
   *
   * Called around the ONE face this update draws, which is why it can be two
   * closures rather than a mode: enter() before the render, leave() after, and
   * a frame that captures nothing never calls either.
   */
  update(renderer, scene, head, surfaceY, dt, air = null) {
    if (!(dt >= 0)) throw new Error(`WorldProbe.update: needs a real dt, got ${dt}`)

    // THE CROSS-FADE, stepped first so a fade that finishes this frame frees the
    // probe to start the next burst in the same frame rather than the one after.
    if (this.filling < 0 && this.fade !== this.live) {
      const step = dt / WORLD_PROBE.fadeSeconds
      this.fade = this.live === 1 ? Math.min(1, this.fade + step) : Math.max(0, this.fade - step)
    }

    const busy = this.filling >= 0 || this.fade !== this.live

    // RE-ANCHOR. Squared distance from her head, and deliberately including y:
    // swimming down through ten metres of water changes what the surface
    // overhead reflects as surely as walking does.
    //
    // REFUSED WHILE BUSY. There is only one spare cube, so a second burst would
    // have to overwrite the one mid-fade -- and at flying speed 12 m comes round
    // faster than a second, so honouring every crossing would mean every
    // handover ending in the snap this exists to remove. Deferring lets the
    // reflection go staler and keeps every transition smooth, which is the way
    // round this feature was asked for.
    if (!busy && head.distanceToSquared(this.origin) > WORLD_PROBE.moveRefresh * WORLD_PROBE.moveRefresh) {
      this.origin.copy(head)
      if (this.vantage === null || !this.vantage(head, this.anchor)) {
        // No water within reach of her, so the capture is taken where she is,
        // under the duck floor on BOTH branches: the surface offset wins only
        // where it is genuinely higher, which is only ever when she is in it.
        const floor = head.y - WORLD_PROBE.duck
        const y = surfaceY === null ? floor : Math.max(surfaceY + WORLD_PROBE.height, floor)
        this.anchor.set(head.x, y, head.z)
      }
      this.filling = 1 - this.live
      this.burst = FACES.length
      this.face = 0
    }

    // Which cube this frame writes to: the spare one during a burst, otherwise
    // the live one, whose faces are only ever being topped up for the light.
    const writing = this.filling >= 0 ? this.filling : this.live
    const target = writing === 0 ? this.a : this.b

    if (this.burst > 0) this.burst--
    else if (this.filling >= 0 || this.fade !== this.live) return
    else if (this.frame++ % WORLD_PROBE.everyNFrames !== 0) return

    // The six cameras have no orientation until updateCoordinateSystem runs, and
    // CubeCamera only calls it from its own update(), which this never uses.
    // Skipping it is the failure that looks like it works: six cameras all
    // facing -Z, every face the same slice of world.
    if (this.rig.coordinateSystem !== renderer.coordinateSystem) {
      this.rig.coordinateSystem = renderer.coordinateSystem
      this.rig.updateCoordinateSystem()
    }

    // The anchor, not the head. The faces of one cube must agree about where
    // they were taken from, or the seams between them move as she does.
    this.rig.position.copy(this.anchor)
    this.rig.updateMatrixWorld(true)

    // THE AIR SWAP IS THE OUTER OF THE TWO, and that ordering is not cosmetic.
    // This function's own swap sets scene.background to null for the length of
    // the capture -- alpha zero is the payload -- and the host's murk writes a
    // colour INTO scene.background. Nested the other way round, leave() runs
    // while the background is still null and throws on the first frame she puts
    // her head under. So: air on, probe state swapped, render, probe state back,
    // air off, and neither half can see the other's null.
    if (air !== null) air.enter()

    const wasXR = renderer.xr.enabled
    const prevTarget = renderer.getRenderTarget()
    const prevBackground = scene.background
    renderer.getClearColor(scratchColor)
    const prevAlpha = renderer.getClearAlpha()

    renderer.xr.enabled = false
    // Alpha zero is the payload: it is what "no land along this ray" means, and
    // water.js reads it as such. Black rather than any other colour so that the
    // soft edge of an alpha-tested card fades toward nothing rather than toward
    // a colour that was never there.
    renderer.setClearColor(0x000000, 0)
    scene.background = null

    const wasVisible = []
    for (let i = 0; i < this.hidden.length; i++) {
      wasVisible.push(this.hidden[i].visible)
      this.hidden[i].visible = false
    }

    const cam = this.rig.children[FACES[this.face]]
    renderer.setRenderTarget(target, FACES[this.face])
    // The clear is unaffected by `air` either way: it goes to transparent black
    // because alpha zero is what "nothing along this ray" means, and no
    // atmosphere changes that.
    renderer.clear(true, true, false)
    renderer.render(scene, cam)

    for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = wasVisible[i]

    scene.background = prevBackground
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(scratchColor, prevAlpha)
    renderer.xr.enabled = wasXR

    // AFTER the background is back, per the note at the top of the swap.
    if (air !== null) air.leave()

    this.face = (this.face + 1) % FACES.length
    this.captures++

    // BURST COMPLETE: hand the finished cube to the shader. `live` is what the
    // fade walks toward, so moving it is the entire handover -- and it is set
    // only here, after the fifth face has actually landed, so a half-filled cube
    // can never be the thing being mixed in.
    if (this.filling >= 0 && this.burst === 0) {
      const first = !this.everFilled[this.filling]
      this.everFilled[this.filling] = true
      this.live = this.filling
      this.filling = -1
      // Nothing to fade FROM on the very first cube: the other target has never
      // been drawn into and is transparent black everywhere, which would fade
      // the world in from a flat silhouette over a second every time the page
      // loads. Snap instead.
      if (first && !this.everFilled[1 - this.live]) this.fade = this.live
    }
  }

  /** The fade with its ends eased, which is what the shader actually mixes by.
   *  A linear cross-fade starts and stops abruptly enough to read as two small
   *  jumps at the ends of the smooth part, which is the artefact this is for. */
  get blend() {
    const t = this.fade
    return t * t * (3 - 2 * t)
  }
}
