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
 * WHERE IT IS CAPTURED FROM: 20 cm above the water, at her own x/z. Not at the
 * head: a capture taken two metres up and then sampled by a surface at water
 * level puts the horizon in the wrong place, and the horizon is the one feature
 * a grazing reflection is entirely made of.
 */
import * as THREE from 'three'

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

export class WorldProbe {
  constructor() {
    this.target = new THREE.WebGLCubeRenderTarget(WORLD_PROBE.size, {
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
    this.texture = this.target.texture

    // near is 30 cm rather than the sky probe's 1 m: the capture point is 20 cm
    // off the water and a bank can come right up to it. far is the sky probe's,
    // which brackets the furthest terrain the world can draw.
    this.rig = new THREE.CubeCamera(0.3, 30000, this.target)

    // Left on layer 0 -- the ordinary scene, which is the entire point. What is
    // excluded is excluded by visibility, below, not by layer.

    this.face = 0
    this.frame = 0
    this.captures = 0

    // Where the current cube was taken from, and the thing moveRefresh measures
    // against. Starts absurd so the first update always anchors.
    this.anchor = new THREE.Vector3(Infinity, Infinity, Infinity)

    // Faces still owed after a re-anchor. Counted down one per frame.
    this.burst = 0

    // Objects hidden for the duration of every capture. See the header.
    this.hidden = []
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
   * One face, or nothing. Call once per frame BEFORE the main render, for the
   * same reason the sky probe insists on it: this binds a render target and
   * leaves it unbound, and doing that after the XR framebuffer is set up draws
   * the frame into the wrong buffer.
   *
   * `surfaceY` is the level of the water she is at or nearest to. Pass null
   * where there is none, and the capture is taken at her feet instead -- which
   * is not used by anything, but keeps the cube from being taken from inside a
   * hillside two hundred metres up.
   */
  update(renderer, scene, head, surfaceY) {
    const y = surfaceY === null ? head.y : surfaceY + WORLD_PROBE.height

    // RE-ANCHOR. Squared distance, and deliberately including y: swimming down
    // through ten metres of water changes what the surface overhead reflects as
    // surely as walking does.
    const dx = head.x - this.anchor.x
    const dy = y - this.anchor.y
    const dz = head.z - this.anchor.z
    if (dx * dx + dy * dy + dz * dz > WORLD_PROBE.moveRefresh * WORLD_PROBE.moveRefresh) {
      this.anchor.set(head.x, y, head.z)
      this.burst = FACES.length
    }

    if (this.burst > 0) this.burst--
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
    renderer.setRenderTarget(this.target, FACES[this.face])
    renderer.clear(true, true, false)
    renderer.render(scene, cam)

    for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = wasVisible[i]

    scene.background = prevBackground
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(scratchColor, prevAlpha)
    renderer.xr.enabled = wasXR

    this.face = (this.face + 1) % FACES.length
    this.captures++
  }
}
