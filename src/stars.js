import THREE from './three-instance.js'
import { CLOCK } from './clock.js'
import { CLOUD_GLSL, makeCloudUniforms } from './sky-glsl.js'

// ---------------------------------------------------------------------------
// The starfield: one THREE.Points draw of a few thousand stars on a sphere,
// rotating about the celestial pole.
//
// WHY POINTS AND NOT A TEXTURE. A star map on the dome is the obvious approach
// and it is wrong on this hardware for one specific reason: a star is a
// sub-pixel point source, and every texture path -- cubemap, equirect, doesn't
// matter -- resolves it through a bilinear filter that smears it across
// whatever the mip level is at that view angle. On a Quest 3, an 8-bit 2048
// cubemap face works out to roughly two texels per degree, so every star lands
// as a soft grey blob and the field reads as noise rather than as stars. Points
// are rasterised at their true size in FRAMEBUFFER pixels, so a faint star is a
// hard, crisp 1.5 px dot, which is exactly what a star looks like.
//
// It is also cheaper: 2400 points is one draw call and no texture memory at
// all, against 25 MB for the cubemap that would look worse.
//
// WHAT IS ACTUALLY MODELLED HERE, and each of these is visible:
//   - Magnitude distribution, so most stars are faint and a handful are not.
//   - Colour by spectral class, from blue-white through to orange.
//   - The Milky Way, as a density enhancement in WHERE the stars are rather
//     than as a painted band. This is the honest way round and it costs zero
//     shader instructions -- see the note at makeStars.
//   - Scintillation, stronger near the horizon, because that is where the line
//     of sight passes through the most air. Stars overhead barely twinkle.
//   - Diurnal rotation about the pole, which at latitude 65 sits two thirds of
//     the way up the northern sky and means the field wheels rather than
//     slides.
// ---------------------------------------------------------------------------

const RADIUS = 15000
const COUNT = 2400
const DEG = Math.PI / 180

// Integer hash + a small LCG, so the field is identical every run. The stars
// have to be in the same places each session for the sky to feel like a place
// rather than a screensaver.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// Spectral sequence, hot to cool, as linear-ish RGB tints. Real star colours
// are far more subtle than the internet's star charts suggest -- the eye's
// colour response gives out at these brightnesses, so only the brightest stars
// show any hue at all. These are deliberately gentle; saturated red and blue
// stars read as pixel dirt.
const SPECTRA = [
  [0.72, 0.80, 1.0], // O/B  blue-white
  [0.86, 0.90, 1.0], // A    white with a cast
  [1.0, 0.98, 0.95], // F/G  white
  [1.0, 0.94, 0.82], // K    warm
  [1.0, 0.84, 0.68], // M    orange
]
// Weights roughly follow how often each class shows up among stars bright
// enough to see, not how often it exists (M dwarfs are most of the galaxy and
// none of them are naked-eye).
const SPECTRA_W = [0.12, 0.2, 0.34, 0.22, 0.12]

function makeStars(seed) {
  const rand = rng(seed)
  const pos = new Float32Array(COUNT * 3)
  const col = new Float32Array(COUNT * 3)
  const size = new Float32Array(COUNT)
  const phase = new Float32Array(COUNT)

  // The galactic plane, as a pole vector in the star sphere's own frame. Tilted
  // off the celestial pole by 27 deg because the real one is at 62.9 -- the
  // Milky Way crosses the sky at a steep angle to the star field's rotation,
  // and if it were parallel to it the whole thing would just spin in place.
  const gp = new THREE.Vector3(Math.sin(63 * DEG), Math.cos(63 * DEG), 0).normalize()

  for (let i = 0; i < COUNT; i++) {
    // ---- Position, with the Milky Way baked into the DENSITY.
    //
    // §13 says keep the sky's fragment shaders short, and a painted galactic
    // band is a per-fragment noise evaluation over half the visible sky for
    // something that is, physically, just more stars in one place. Doing it as
    // rejection sampling on the CPU at load costs a few hundred microseconds
    // once and nothing per frame, and it is also more correct: the Milky Way
    // resolves into individual stars, which is why it looks the way it does.
    let x, y, z, d
    for (;;) {
      // Uniform on the sphere: z uniform in -1..1, longitude uniform. The naive
      // "two random angles" version piles stars up at the poles.
      const u = rand() * 2 - 1
      const th = rand() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      x = r * Math.cos(th)
      y = u
      z = r * Math.sin(th)
      d = Math.abs(x * gp.x + y * gp.y + z * gp.z)
      // 1.0 in the plane falling to 0.34 at the galactic poles. The band comes
      // out about 12 deg wide at half density, which is close to the real
      // thing's naked-eye width.
      const p = 0.34 + 0.66 * Math.exp(-((d / 0.2) * (d / 0.2)))
      if (rand() < p) break
    }
    pos[i * 3] = x * RADIUS
    pos[i * 3 + 1] = y * RADIUS
    pos[i * 3 + 2] = z * RADIUS

    // ---- Magnitude.
    //
    // A cube of a uniform gives many faint and few bright, which is the shape
    // of the real distribution closely enough. Stars in the Milky Way band get
    // pulled fainter: they are farther away, and a band made of bright stars
    // looks like a string of lights rather than a haze.
    const band = Math.exp(-((d / 0.2) * (d / 0.2)))
    const m = Math.pow(rand(), 3) * (1 - band * 0.45)
    size[i] = 1.1 + m * 3.4
    const bright = 0.16 + m * 1.5

    // ---- Colour.
    let w = rand()
    let k = 0
    while (k < SPECTRA_W.length - 1 && w > SPECTRA_W[k]) {
      w -= SPECTRA_W[k]
      k++
    }
    // Faint stars desaturate toward white: below about magnitude 2 the eye's
    // cones have nothing to work with and everything is grey.
    const sat = 0.35 + m * 0.65
    col[i * 3] = (1 + (SPECTRA[k][0] - 1) * sat) * bright
    col[i * 3 + 1] = (1 + (SPECTRA[k][1] - 1) * sat) * bright
    col[i * 3 + 2] = (1 + (SPECTRA[k][2] - 1) * sat) * bright

    phase[i] = rand() * Math.PI * 2
  }

  return { pos, col, size, phase }
}

export class Stars {
  // `clouds` is the sky's cloud uniform block (sky-glsl.js makeCloudUniforms),
  // shared by reference so the cloud that hides the sun hides the stars under
  // it; without one the field is drawn under a clear sky.
  constructor(scene, { seed = 1, pixelRatio = 1, clouds = makeCloudUniforms() } = {}) {
    const { pos, col, size, phase } = makeStars(seed)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
    // The sphere is centred on the head every frame, so the default bounding
    // sphere would be computed once about the origin and go stale. Culling is
    // off instead (see below), but a sane bounding sphere keeps anything that
    // does read it from getting nonsense.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFade: { value: 0 },
        uTime: { value: 0 },
        uPixel: { value: pixelRatio },
        uClouds: clouds.uClouds,
        uCloud: clouds.uCloud,
        uCloudDrift: clouds.uCloudDrift,
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixel;
        varying vec3 vCol;
        ${CLOUD_GLSL}

        void main() {
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mv;

          // The star's world DIRECTION. mat3 of the model matrix is the pole
          // rotation with the head-following translation dropped, which is
          // exactly what is wanted: elevation above the horizon.
          vec3 wdir = normalize( mat3( modelMatrix ) * position );

          // Scintillation. Amplitude scales with air mass -- near the horizon a
          // sightline crosses roughly forty times the atmosphere it does at the
          // zenith, which is why low stars flash and high ones sit still. Two
          // sines at an irrational-ish ratio so it never settles into a beat.
          float air = 1.0 - smoothstep( 0.0, 0.5, max( wdir.y, 0.0 ) );
          float amp = 0.06 + 0.5 * air;
          float tw = 1.0 + amp * ( sin( uTime * 5.3 + aPhase ) * 0.6
                                 + sin( uTime * 8.9 + aPhase * 2.7 ) * 0.4 );

          // Extinction: stars genuinely go out near the horizon, and cutting
          // them off at exactly y = 0 would draw a hard line of stars sitting
          // on the mountains. This fades the last few degrees.
          float ext = smoothstep( -0.02, 0.12, wdir.y );

          // The cloud in front of it, fetched here per star rather than per
          // fragment: a star is a point, so one direction is the whole of it.
          float cloud = cloudAt( wdir ).x;

          vCol = aColor * tw * ext * ( 1.0 - cloud );

          // Size in framebuffer pixels, not world units -- no distance
          // attenuation, because a star has no distance worth modelling.
          gl_PointSize = aSize * uPixel;
        }
      `,
      fragmentShader: `
        uniform float uFade;
        varying vec3 vCol;

        void main() {
          // A soft round core. A hard disc test aliases horribly on a point
          // this small; the gaussian gives a sub-pixel-looking dot with an
          // antialiased edge for free.
          vec2 d = gl_PointCoord - 0.5;
          float g = exp( -dot( d, d ) * 14.0 );
          gl_FragColor = vec4( vCol * uFade, g );
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      // Additive, which is what light actually does: stars add to the sky, they
      // do not replace it. It also means no sorting is needed among them.
      blending: THREE.AdditiveBlending,
      // Depth TESTED but not written. Being in the transparent pass, this draws
      // after all opaque geometry has filled the depth buffer, so mountains
      // occlude stars correctly with no renderOrder games -- at RADIUS 15000
      // every piece of terrain in a 16 km world is nearer than the sphere.
      depthWrite: false,
      depthTest: true,
      fog: false,
    })

    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = -900
    // Hidden entirely when the fade is zero. Not an optimisation for its own
    // sake: it means the whole system costs literally nothing during the day,
    // which is half the runtime.
    this.points.visible = false
    scene.add(this.points)

    // The celestial pole: due north (-z), at an elevation equal to the
    // latitude. Everything in the sky turns about this axis, once a day.
    this._axis = new THREE.Vector3(
      0,
      Math.sin(CLOCK.latitude * DEG),
      -Math.cos(CLOCK.latitude * DEG)
    ).normalize()
  }

  // Call this whenever the renderer's pixel ratio changes -- a render-scale
  // slider, a monitor swap, anything that resizes the drawing buffer.
  // gl_PointSize is a count of FRAMEBUFFER pixels, so a star's size on screen is
  // fixed only as long as the framebuffer is. Halve the render scale without
  // telling the field and every star keeps its pixel count while the buffer it
  // sits in shrinks: it covers twice the fraction of the screen, the upscale to
  // CSS size blows it up again, and additive blending turns the result into
  // burned-in blobs rather than stars.
  setPixelRatio(r) {
    this.material.uniforms.uPixel.value = r
  }

  // `hour` is the clock's monotonic elapsed hours, so the field keeps turning
  // across a time skip instead of snapping back.
  update(head, state, hour, elapsedReal) {
    const fade = state.stars
    this.points.visible = fade > 0.002
    if (!this.points.visible) return

    this.points.position.copy(head)
    // 15 degrees of hour angle per hour, negative because the sky turns the
    // opposite way to the earth. This is the same rotation the sun and moon
    // are already doing in clock.js, so they stay locked to the field.
    this.points.setRotationFromAxisAngle(this._axis, -hour * 15 * DEG)
    this.material.uniforms.uFade.value = fade
    this.material.uniforms.uTime.value = elapsedReal
  }

  dispose() {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
