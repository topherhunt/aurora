import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The aurora borealis.
//
// ===========================================================================
// WHAT AN AURORA ACTUALLY IS, because every shortcut below is a consequence
// ===========================================================================
//
// Solar-wind electrons spiral down the earth's magnetic field lines and hit the
// upper atmosphere. Where they stop, they excite atoms, and the atoms emit at
// fixed wavelengths on the way back down. Three things follow, and all three
// decide how this is rendered:
//
// 1. THE LIGHT IS EMITTED, NOT REFLECTED. An aurora has no shading, no
//    specular, no normal. It is a pure emitter. So: MeshBasicMaterial-class
//    shading, additive blending, no lights, and no interaction with the one
//    directional light in the scene.
//
// 2. IT IS OPTICALLY THIN. The gas is so rarefied that light passes straight
//    through it -- one curtain behind another simply adds. That is a large
//    gift: additive blending is COMMUTATIVE, so nothing has to be depth-sorted,
//    ever. Five overlapping curtains in arbitrary draw order give the identical
//    frame. This is why the whole thing can be one BufferGeometry.
//
// 3. IT IS FIELD-ALIGNED. Electrons follow field lines, which near the pole
//    are close to vertical. Every structure in an aurora is therefore VERTICAL:
//    the rays, the striations, the way a fold keeps its shape from the bottom
//    edge to the top. Nothing in an aurora is horizontally striped. Get this
//    wrong and it reads as coloured fog.
//
// The emission lines, which are the colours and are not negotiable:
//   557.7 nm  atomic oxygen, green      100-150 km   the dominant one by far
//   630.0 nm  atomic oxygen, red        above ~200 km, deep red, diffuse
//   428/470   ionised nitrogen, blue-violet  80-100 km, the pink/purple hem
// So an aurora's colour is a function of ALTITUDE and of nothing else. Not of
// intensity, not of time, not of noise. That single fact does most of the work
// of making this look real rather than like a green ribbon.
//
// ===========================================================================
// LAWLOR & GENETTI, and why there is no volume here
// ===========================================================================
//
// "Interactive Volume Rendering Aurora on the GPU" (Lawlor & Genetti, 2010) is
// the paper on this. Their key structural observation is that an aurora
// FACTORS: it is a 2D curtain footprint -- a curve on the ground plan, which is
// where the electrons come down -- crossed with a 1D deposition function that
// says how brightly it glows at each altitude. There is no third dimension of
// detail, because the field lines carry the pattern straight up.
//
// Which means the expensive thing -- a 3D volume raymarch -- is not merely too
// slow for a Quest, it is unnecessary. The same image comes out of a THIN SHEET
// OF POLYGONS standing on the footprint curve, with the deposition function
// evaluated per fragment from altitude. That is what this file does.
//
// ===========================================================================
// HOW SKYRIM DOES IT, since it was asked about specifically
// ===========================================================================
//
// Skyrim's auroras are not procedural at all. They are authored MESHES, sitting
// under meshes\sky\, each aurora built from several parts and each part carrying
// THREE STACKED LAYERS of geometry. The material is BSEffectShaderProperty --
// Bethesda's emissive/additive shader, no lighting -- and the animation is a
// UV-scroll controller per layer, each layer scrolling its texture at a
// different rate over the same geometry. Vertex colours tint the mesh so the
// bottom edge goes a different colour from the top.
//
// The technique worth stealing is the LAYERING, and it is stolen here: three
// scroll rates over one surface beat one scroll rate at three times the
// resolution, because the interference between layers never repeats and the eye
// cannot find the loop. The layering is what makes those auroras feel alive on
// hardware from 2011.
//
// What is deliberately NOT copied: the authored mesh and the scrolling texture.
// A scrolling texture slides its pattern ACROSS the curtain -- structure moves
// sideways through a stationary shape. Real auroras do the opposite: the shape
// itself deforms in place while the structure stays put on the field lines.
// Skyrim gets away with it because its auroras are a distant backdrop that
// never moves relative to you. Here you can stand under one, and sliding
// texture would give it away instantly. So the layering is kept, the sliding is
// replaced by folds that morph in place (see the vertex shader), and the
// texture is replaced by noise so nothing has to be authored or loaded.
//
// ===========================================================================
// SCALE AND PLACEMENT
// ===========================================================================
//
// Everything below is built in KILOMETRES and scaled by KM on the way out,
// because the physics is quoted in kilometres and a file full of 4050.0 would
// be unreadable. The scale is chosen so the whole structure fits between the
// terrain and the camera's 20000 m far plane:
//
//   nearest curtain point   45 km out,  88 km up  ->  4530 units, 63 deg up
//   farthest curtain point  200 km out, 250 km up -> 14400 units, 51 deg up
//
// The aurora is SKY-LOCKED: it follows the head position with no parallax, like
// the sky dome and the stars. That is not a cheat, it is correct -- at 100 km
// altitude, walking the entire 16 km world moves the aurora by under 5 degrees,
// and the alternative is that it slides past the mountains as she walks, which
// is precisely the wrong cue.
//
// Depth still works, and does the right thing for free: the material is
// transparent, so it draws after the opaque pass has filled the depth buffer,
// with depthTest on and depthWrite off. A mountain in front of the aurora
// occludes it. And the geometry is far enough out and high enough up that this
// only happens where it should -- at 24 deg elevation, the lowest the far arc
// ever gets, a peak would have to be 3.5 km tall at 8 km range to cut into it.
// ---------------------------------------------------------------------------

const KM = 45 // world units per kilometre
const DEG = Math.PI / 180

// Altitude rows. Deliberately not evenly spaced: they are packed where the
// deposition function bends. 88->96 is the hard lower border, and putting three
// rows in the bottom 25 km buys a clean bottom edge at the only place a linear
// interpolation of altitude between rows could show.
const ALTS = [86, 92, 100, 112, 132, 165, 210, 260]

// One entry per curtain. Layered in depth exactly as Skyrim layers in the
// z-buffer, and for the same reason: overlapping structures at different
// distances and different speeds interfere, and interference is what stops a
// procedural sky from having a visible period.
//
// `threshold` is where in the substorm cycle this curtain switches on. The
// distant arc is always there; the overhead one only appears in a real storm,
// which is what makes a storm feel like an event rather than a brightness
// slider.
const CURTAINS = [
  // dist   az      span   fold  drift  bright thresh  seed
  { dist: 200, az: 355, span: 150, fold: 26, drift: 0.020, bright: 0.55, threshold: 0.0, seed: 11 },
  { dist: 145, az: 8, span: 130, fold: 22, drift: -0.031, bright: 0.85, threshold: 0.12, seed: 27 },
  { dist: 96, az: 348, span: 118, fold: 17, drift: 0.044, bright: 1.0, threshold: 0.3, seed: 43 },
  { dist: 62, az: 20, span: 96, fold: 12, drift: -0.058, bright: 0.9, threshold: 0.52, seed: 61 },
  { dist: 38, az: 340, span: 78, fold: 8, drift: 0.077, bright: 0.75, threshold: 0.74, seed: 79 },
]

// Samples along each curtain's footprint. 200 gives a fold wavelength of about
// 8 samples at the shortest wavelength the vertex shader displaces at, which is
// enough that the silhouette reads as a smooth curve rather than a polyline.
const SEGS = 200

// Shared GLSL. Integer-hash value noise -- the same shape as the one in
// terrain-material.js and for the same recorded reason: the fract(sin(dot))
// hash degenerates once its inputs get large, and these inputs are kilometres
// plus a monotonically increasing time. That hash was measured collapsing to
// two distinct values at 6 km in the terrain shader.
const NOISE_GLSL = `
  float aurHash( vec2 p ) {
    uvec2 q = uvec2( ivec2( floor( p ) ) ) * uvec2( 1597334673u, 3812015801u );
    uint n = ( q.x ^ q.y ) * 1597334673u;
    return float( n ) * ( 1.0 / 4294967296.0 );
  }
  float aurNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( aurHash( i ),                 aurHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( aurHash( i + vec2( 0.0, 1.0 ) ), aurHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
`

// The fold displacement, shared between the vertex shader's position and its
// finite-difference normal so the two cannot drift apart. Returns kilometres
// sideways along the footprint normal.
//
// Three octaves at rates that are not integer multiples of each other -- this
// is Skyrim's three-layer trick, moved from UV scroll onto the fold amplitude.
// The time term is INSIDE the noise rather than added to the coordinate, which
// is the whole difference: adding to the coordinate slides the pattern along
// the curtain, putting it in the second axis makes the pattern MORPH IN PLACE.
// Real folds do the latter.
const FOLD_GLSL = `
  float aurFold( float km, float t, float amp, float act ) {
    float f = ( aurNoise( vec2( km * 0.0125, t * 0.055 ) ) - 0.5 ) * 1.0;
    f     += ( aurNoise( vec2( km * 0.0410, t * 0.130 ) ) - 0.5 ) * 0.52;
    // The third octave is gated on activity. A quiet aurora is a smooth arc;
    // the fine curls only appear at breakup. That progression -- arc, then
    // folds, then curls -- is the Akasofu substorm sequence, and animating it
    // is most of why standing and watching this is worth doing.
    f     += ( aurNoise( vec2( km * 0.1350, t * 0.310 ) ) - 0.5 ) * 0.34 * act;
    return f * amp;
  }
`

function buildGeometry() {
  const pos = []
  const aKm = [] // distance along the footprint, km -- drives folds and rays
  const aAlt = [] // altitude, km -- drives colour and deposition
  const aNrm = [] // footprint normal in plan, horizontal unit vector
  const aTan = [] // footprint tangent in plan, for the finite-difference normal
  const aEnv = [] // per-curtain: x = end taper coord, y = brightness, z = threshold
  const aSeed = []
  const idx = []

  for (const c of CURTAINS) {
    const base = pos.length / 3
    // Arc length of the footprint in km. The curtain is a circular arc centred
    // on the viewer, which is what an auroral arc looks like from underneath --
    // the oval is thousands of km across, so the near part of it reads as a
    // band crossing the sky rather than as a ring.
    const arcKm = c.dist * c.span * DEG

    for (let i = 0; i <= SEGS; i++) {
      const s = i / SEGS
      const azDeg = c.az - c.span / 2 + c.span * s
      const a = azDeg * DEG
      // North is -z, east is +x, matching clock.js's azimuth convention.
      const dx = Math.sin(a)
      const dz = -Math.cos(a)
      // Tangent along the arc, and the outward normal, both in plan.
      const tx = Math.cos(a)
      const tz = Math.sin(a)

      for (let k = 0; k < ALTS.length; k++) {
        pos.push(dx * c.dist, ALTS[k], dz * c.dist)
        aKm.push(s * arcKm)
        aAlt.push(ALTS[k])
        aNrm.push(dx, 0, dz)
        aTan.push(tx, 0, tz)
        aEnv.push(s, c.bright, c.threshold)
        aSeed.push(c.seed)
      }
    }

    const rows = ALTS.length
    for (let i = 0; i < SEGS; i++) {
      for (let k = 0; k < rows - 1; k++) {
        const a0 = base + i * rows + k
        const b0 = base + (i + 1) * rows + k
        idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aKm', new THREE.Float32BufferAttribute(aKm, 1))
  geo.setAttribute('aAlt', new THREE.Float32BufferAttribute(aAlt, 1))
  geo.setAttribute('aNrm', new THREE.Float32BufferAttribute(aNrm, 3))
  geo.setAttribute('aTan', new THREE.Float32BufferAttribute(aTan, 3))
  geo.setAttribute('aEnv', new THREE.Float32BufferAttribute(aEnv, 3))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1))
  geo.setIndex(idx)
  // Sky-locked and always in view somewhere; culling a single 30k-triangle draw
  // against a bounding sphere that has to be recomputed every frame is a worse
  // deal than not culling it.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 150 * KM, 0), 400 * KM)
  return geo
}

export class Aurora {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uActivity: { value: 0 },
      },
      vertexShader: `
        attribute float aKm;
        attribute float aAlt;
        attribute vec3 aNrm;
        attribute vec3 aTan;
        attribute vec3 aEnv;
        attribute float aSeed;

        uniform float uTime;
        uniform float uActivity;

        varying float vAlt;
        varying float vKm;
        varying float vEnv;
        varying float vBright;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vSeed;

        ${NOISE_GLSL}
        ${FOLD_GLSL}

        void main() {
          vAlt = aAlt;
          vSeed = aSeed;
          vBright = aEnv.y;

          // Per-curtain switch-on. Below its threshold a curtain is not merely
          // dim, it is GONE -- collapsed to zero displacement and zero
          // brightness -- so a quiet sky is genuinely one thin arc rather than
          // five faint ones stacked up looking like haze.
          float live = smoothstep( aEnv.z, aEnv.z + 0.18, uActivity );

          // Taper both ends of the ribbon to nothing. An aurora that stops dead
          // in mid-air is the single most obvious tell there is; real arcs fade
          // out along their length as the precipitation thins.
          vEnv = smoothstep( 0.0, 0.14, aEnv.x ) * smoothstep( 1.0, 0.86, aEnv.x )
               * live;

          float t = uTime + aSeed * 37.0;
          // Fold amplitude grows with altitude. Field lines converge downward,
          // so a fold is tighter at the bottom edge and splays out above -- it
          // is why curtains look like curtains and not like walls.
          float amp = ( 12.0 + uActivity * 22.0 ) * ( 0.55 + aAlt * 0.0042 ) * live;

          float f0 = aurFold( aKm, t, amp, uActivity );

          // Analytic-ish surface normal by finite difference along the
          // footprint. Two extra noise evaluations at 1600 vertices per curtain
          // is nothing, and the payoff is the edge-on brightening in the
          // fragment shader, which is the effect that turns a smooth ribbon
          // into distinct bright rays. Without a correct normal here that
          // effect points the wrong way and actively looks worse than nothing.
          float dk = 2.0;
          float f1 = aurFold( aKm + dk, t, amp, uActivity );
          // Tangent of the displaced curve in plan: along-track plus the rate
          // of change of the sideways displacement.
          vec3 tanW = normalize( aTan * dk + aNrm * ( f1 - f0 ) );
          // The sheet is vertical, so its normal is the plan tangent turned 90
          // degrees about up.
          vNormal = normalize( vec3( -tanW.z, 0.0, tanW.x ) );

          // Slow drift along the arc, on top of the morphing. Real arcs do
          // translate -- usually westward before midnight -- and a purely
          // in-place animation reads as a video loop.
          vKm = aKm + uTime * 0.9;

          vec3 p = position + aNrm * f0;
          p *= ${KM.toFixed(1)};

          vec4 world = modelMatrix * vec4( p, 1.0 );
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform float uActivity;

        varying float vAlt;
        varying float vKm;
        varying float vEnv;
        varying float vBright;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vSeed;

        ${NOISE_GLSL}

        void main() {
          // ---- Deposition: how brightly the gas glows at this altitude.
          //
          // This is the whole vertical profile of the aurora in two terms, and
          // it is the shape of the real thing. The smoothstep is the LOWER
          // BORDER: electrons of a given energy penetrate to a definite depth
          // and stop, so the bottom edge of an aurora is startlingly sharp --
          // sharper than anything else in the sky. The exponential above it is
          // the tail of the energy spectrum, which is why the top just fades
          // out with no edge at all. Getting these two the right way round is
          // most of the silhouette.
          float dep = smoothstep( 86.0, 99.0, vAlt ) * exp( -( vAlt - 99.0 ) / 62.0 );

          // ---- Colour by altitude, and by nothing else. See the header.
          //
          // The nitrogen hem is the detail people recognise without being able
          // to name: a narrow band of pink-violet along the very bottom edge,
          // present only during real activity because it needs electrons
          // energetic enough to reach 90 km. Gating it on uActivity means a
          // quiet arc is plain green and a storm gets its magenta fringe.
          vec3 col = mix( vec3( 0.62, 0.18, 0.72 ),      // N2+ violet, 428 nm
                          vec3( 0.14, 1.00, 0.44 ),      // OI green, 557.7 nm
                          smoothstep( 92.0, 111.0, vAlt ) );
          col = mix( col, vec3( 1.00, 0.16, 0.30 ),      // OI red, 630.0 nm
                     smoothstep( 155.0, 245.0, vAlt ) * 0.85 );

          // ---- Rays: vertical striations, a function of ALONG-CURTAIN
          // position only.
          //
          // This is the field-alignment constraint from the header, expressed
          // as one missing term: there is no vAlt anywhere in this noise
          // lookup, so every ray runs perfectly vertically from the bottom edge
          // to the top, exactly as electrons do. Adding an altitude term here
          // would be one character and would destroy the effect.
          //
          // Two octaves: ~1.4 km fine structure and ~8 km clumping, which are
          // about the real spacings.
          float t = uTime * 0.5 + vSeed;
          float ray = aurNoise( vec2( vKm * 0.72, t * 0.9 ) ) * 0.62
                    + aurNoise( vec2( vKm * 0.13, t * 0.4 ) ) * 0.38;
          // Rays are crisp at the bottom and blur out with altitude, because
          // the emitting region spreads as the field lines diverge. Contrast is
          // also a function of activity: a quiet arc is nearly featureless.
          float crisp = mix( 1.0, 0.25, smoothstep( 100.0, 200.0, vAlt ) );
          float contrast = ( 0.35 + 0.65 * uActivity ) * crisp;
          ray = mix( 1.0, ray * 1.8, contrast );

          // ---- Edge-on brightening.
          //
          // The one lighting term an optically thin emitter has. Looking along
          // the sheet you see through far more glowing gas than looking square
          // at it, so brightness goes as 1/|cos| of the view angle to the
          // surface. This is why an aurora is a set of bright vertical bands
          // rather than an even wash: those bands are the folds, seen edge-on.
          //
          // It is also self-animating for free. The folds turn as they morph,
          // so bands light up and die away without a single extra noise
          // evaluation -- which matters, because §13 says this is the one
          // fragment shader where length shows up in frametime.
          //
          // Clamped at 4, not left to blow up: an exactly edge-on polygon is a
          // division by zero and a line of fireflies across the sky.
          vec3 view = normalize( vWorld - cameraPosition );
          float grazing = clamp( 1.0 / max( abs( dot( view, normalize( vNormal ) ) ), 0.16 ), 1.0, 4.2 );

          // ---- Atmospheric extinction near the horizon. The far arc's base
          // sits low, and light from it crosses a great deal of air.
          float ext = smoothstep( -0.03, 0.14, view.y );

          float a = dep * ray * grazing * ext * vEnv * vBright * uIntensity * 0.42;

          gl_FragColor = vec4( col * max( a, 0.0 ), 1.0 );
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      // Additive, and therefore order-independent -- see note 2 in the header.
      // This is why five interpenetrating curtains can live in one draw call
      // with no sorting.
      blending: THREE.AdditiveBlending,
      // Depth tested, never written. The transparent pass runs after the opaque
      // one, so the depth buffer already holds the terrain: mountains occlude
      // the aurora, and the aurora never occludes itself.
      depthWrite: false,
      depthTest: true,
      // Curtains are two-sided; you can walk under one and look back.
      side: THREE.DoubleSide,
      // Fog would erase this completely. At 10 km with FogExp2 at night's
      // density the fog factor is about 1e-7 -- the aurora is above the
      // atmosphere the fog is modelling, so it must not be in it.
      fog: false,
    })

    this.mesh = new THREE.Mesh(buildGeometry(), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -800
    // Off entirely whenever there is nothing to draw, which is all day. Not a
    // micro-optimisation: it is the difference between this system costing
    // nothing at noon and costing a 30k-triangle transparent pass at noon.
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  // `head` is her world position, `state` the clock state, `elapsedReal` real
  // seconds since start.
  //
  // The animation clock is REAL seconds, not in-world hours, and deliberately:
  // the folds should shimmer at the speed a real aurora shimmers regardless of
  // how fast the day is running, and a time skip should not fast-forward the
  // curtains through six minutes of writhing in one frame.
  update(head, state, elapsedReal) {
    const i = state.aurora
    this.mesh.visible = i > 0.004
    if (!this.mesh.visible) return

    this.mesh.position.copy(head)
    const u = this.material.uniforms
    u.uTime.value = elapsedReal
    u.uIntensity.value = i
    u.uActivity.value = state.activity
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
