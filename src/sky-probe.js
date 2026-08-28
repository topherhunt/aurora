/**
 * SKY PROBE -- the aurora, captured so the water can reflect it.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY DOES NOT CAPTURE
 *
 * The water's sky reflection is analytic: sky-glsl.js turns a direction into a
 * colour, so water.js calls it along the reflected ray and gets a perfect
 * answer for free, at every time of day, with no render target and no 8-bit
 * round trip. Nothing here replaces that, and it would be a downgrade if it
 * tried -- a low-res capture of a smooth night gradient bands, which is the
 * exact reason sky.js was never a cubemap in the first place.
 *
 * What the analytic path structurally cannot do is the aurora: parametric
 * geometry with a dozen noise evaluations per vertex, additively blended, with
 * no function to call. So this captures that one thing and only that one thing,
 * and water.js ADDS the result to the analytic sky -- which is exactly how the
 * aurora is composited into the real sky, so the two paths agree by
 * construction rather than by tuning.
 *
 * NOT THE STARS, and the reason is a unit mismatch rather than a cost. Stars are
 * POINTS, and gl_PointSize is a count of FRAMEBUFFER pixels, not an angle. The
 * 1.1 to 4.5 px speck that is correct on a 1500 px-wide screen covers the same
 * 1.1 to 4.5 px of a 64 px cube face, which is 1.5 to 6.3 DEGREES -- against the
 * ~0.05 degrees a real star subtends. All 2400 of them at 30 to 100 times size
 * is a lake reflecting gravel, and there is no size that fixes it: a star has to
 * live under a pixel, and this probe's bilinear filter would smear a sub-pixel
 * point into nothing on the way back out. See the header of stars.js, which
 * makes the same argument about why stars can only be screen-space points.
 *
 * That split is what makes the capture cheap enough to be worth having. It
 * carries only soft, diffuse, additive light, so 64 pixels a face is plenty;
 * there is no gradient in it to band; and if the probe were switched off
 * tomorrow the lake would lose its aurora and keep everything else.
 *
 * THE COST, AND WHERE IT ACTUALLY IS
 *
 * Not in the fragments -- 64^2 is 4k pixels a face. It is all in the aurora's
 * vertex shader: 11 slots x 181 samples x 10 rows is 19,910 vertices, each
 * running the fold, swoop, flare and hem noise. Capturing all six faces at
 * once would run that six times in one frame, which is the spike worth
 * avoiding.
 *
 * So the unit of work is ONE FACE, not one capture. Each update renders a
 * single face and moves on; five updates come back round to the start. That
 * makes the per-update cost a single aurora vertex pass no matter how often
 * the probe ticks, and it means the way to make this cheaper is to render less
 * per update rather than to update less often -- which is the better trade,
 * because a slower cadence would show as the aurora's reflection lagging the
 * aurora while a smaller slice of work shows as nothing at all.
 *
 * FIVE faces, not six: water.js folds the reflected ray into the upper
 * hemisphere before sampling, so -Y is never read and rendering it would be
 * pure waste.
 *
 * PARALLAX: none worth having. The aurora sits 5.5 to 17.6 km out, so a capture
 * taken at the head and reused for a hundred metres of walking is off by about a
 * degree. The camera is moved to the head anyway because it is free, but nothing
 * depends on it being current.
 *
 * THE LAYER TRAP -- READ THIS BEFORE CHANGING THE LAYER NUMBER
 *
 * The obvious way to capture two objects out of a scene is to move them to
 * their own layer and point the probe camera at it. In WebXR that is a bug
 * with a very convincing disguise. three's WebXRManager does:
 *
 *     cameraXR.layers.mask = camera.layers.mask | 0b110;
 *     cameraL.layers.mask  = cameraXR.layers.mask & 0b011;
 *     cameraR.layers.mask  = cameraXR.layers.mask & 0b101;
 *
 * Layers 1 and 2 are reserved for the left and right eye, and the masking is
 * three bits wide, so an object on ANY layer above 2 is drawn by neither eye.
 * Moving the aurora to a private layer would leave it perfect on the desktop
 * canvas and invisible in the headset.
 *
 * So nothing is moved. The aurora stays on layer 0 exactly as it was, and is
 * additionally ENABLED on PROBE_LAYER. Object layers are a mask and a camera
 * draws an object when the masks intersect: the XR eyes still see it via layer
 * 0, and this camera -- an ordinary camera, outside the XR path -- sees it and
 * nothing else via PROBE_LAYER.
 */
import THREE from './three-instance.js'

const scratchColor = new THREE.Color()

// Above the eye layers, and irrelevant to them: see the layer trap above.
export const PROBE_LAYER = 3

export const PROBE = {
  // Per face. The aurora is a soft diffuse curtain being reflected in moving
  // water; there is nothing here that 64 pixels cannot hold.
  size: 64,
  // Frames between updates. One face per update, five faces to go round, so a
  // full refresh takes this many frames times five -- 10 frames, about 0.14 s
  // at 72 Hz, against an aurora whose fastest fold takes about a second.
  everyNFrames: 2,
  // How strongly the captured light shows up in the water. 1.0 is "as bright
  // as the sky above it"; the reflection tint in water.js takes its cut on top.
  gain: 1.0,
}

// +X, -X, +Y, -Y, +Z, -Z, which is the cube face order WebGLCubeRenderTarget
// uses. -Y is index 3 and is the one left out.
const FACES = [0, 1, 2, 4, 5]

export class SkyProbe {
  constructor() {
    this.target = new THREE.WebGLCubeRenderTarget(PROBE.size, {
      // HALF FLOAT, and it matters even for a capture this small. The aurora is
      // additive light whose interesting range sits well under one 8-bit step
      // at the dim end; quantising it to a byte would post-erise the curtain
      // into flat plates in the water while looking fine in the sky.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      // Nothing here occludes anything else -- both meshes are additive and
      // depth-writeless -- so the depth attachment would be allocated, cleared
      // and never read.
      depthBuffer: false,
    })
    this.texture = this.target.texture

    // Six 90-degree cameras with the orientations the cube faces want. Built by
    // CubeCamera rather than by hand because getting six up-vectors and the
    // handedness right is exactly the kind of thing that is subtly wrong for a
    // week. near/far bracket everything the probe can see: the aurora reaches
    // out to 17.6 km.
    //
    // Its children share ONE Layers instance -- CubeCamera assigns
    // `camera.layers = this.layers` rather than copying -- so this is one write,
    // not six, and setting a child's layers individually would silently change
    // all of them.
    this.rig = new THREE.CubeCamera(1, 30000, this.target)
    this.rig.layers.set(PROBE_LAYER)

    this.face = 0
    this.frame = 0
    this.captures = 0
  }

  /** Put the two additive meshes in the probe's view without taking them out of
   *  anyone else's. `enable`, never `set` -- see the layer trap in the header. */
  static include(...objects) {
    for (const o of objects) o.layers.enable(PROBE_LAYER)
  }

  /**
   * One face, or nothing. Call once per frame BEFORE the main render: it binds
   * a render target and leaves it unbound, and doing that between the XR
   * framebuffer being set up and the scene being drawn into it is how you get
   * a frame drawn into the wrong buffer.
   */
  update(renderer, scene, head) {
    if (this.frame++ % PROBE.everyNFrames !== 0) return

    // The six cameras come out of the constructor with no orientation at all --
    // CubeCamera only points them in updateCoordinateSystem(), which its own
    // update() calls lazily on first render. Skipping this is the failure that
    // looks like a working probe: six cameras all facing -Z, so every face
    // captures the same slice of sky and the reflection is subtly, uniformly
    // wrong rather than obviously broken.
    if (this.rig.coordinateSystem !== renderer.coordinateSystem) {
      this.rig.coordinateSystem = renderer.coordinateSystem
      this.rig.updateCoordinateSystem()
    }

    this.rig.position.copy(head)
    this.rig.updateMatrixWorld(true)

    // three routes render() through the XR camera whenever a session is live,
    // so an ordinary camera is ignored and the probe would capture the eye
    // view. Switching XR off for the duration is the standard way round it;
    // what makes it safe is that this runs before the frame's real render, so
    // three sets the session framebuffer up again on the way back in.
    const wasXR = renderer.xr.enabled
    const prevTarget = renderer.getRenderTarget()
    const prevBackground = scene.background
    renderer.getClearColor(scratchColor)
    const prevAlpha = renderer.getClearAlpha()

    renderer.xr.enabled = false
    // Additive light on nothing: the cleared black IS the absence of aurora,
    // and the water adds whatever comes back. Clearing to anything else would
    // double sky the analytic path already supplies.
    renderer.setClearColor(0x000000, 0)
    // ...and scene.background would do exactly that, silently. main.js keeps it
    // tracking the fog colour, so leaving it set fills all five faces with flat
    // daylight grey and the lake turns into a mirror of the fog.
    scene.background = null

    const cam = this.rig.children[FACES[this.face]]
    renderer.setRenderTarget(this.target, FACES[this.face])
    renderer.clear(true, false, false)
    renderer.render(scene, cam)

    scene.background = prevBackground
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(scratchColor, prevAlpha)
    renderer.xr.enabled = wasXR

    this.face = (this.face + 1) % FACES.length
    this.captures++
  }
}
