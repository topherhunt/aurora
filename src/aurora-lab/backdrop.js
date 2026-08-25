import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The lab's mountain backdrop: a whole skyline in one draw call, computed per
// fragment from the view direction's azimuth.
//
// WHY THERE IS NO TERRAIN HERE. The aurora lab's camera sits at a fixed point
// and only ever rotates. A viewer that cannot translate cannot resolve parallax,
// and parallax is the only thing a real mesh of mountains would buy over a
// painted-on ridge line. So the mountains are not geometry at all: they are a
// 1D function of compass bearing, evaluated in the fragment shader, and the only
// geometry is the surface that carries it. One draw, no vertex budget, no LOD,
// no streaming, and it reshuffles the entire skyline the instant a slider moves.
//
// A LAT-BAND SPHERE CAP, NOT A CYLINDER. Both were on the table. The cylinder
// loses on one point that matters more than it sounds: a cylinder is open at the
// bottom, so covering the downward view means making it tall, and "tall enough"
// depends on how far down the camera can be pitched and on how wide the FOV goes
// at full zoom-out. Guess low and the sky shows through underneath the
// mountains, which is the single most obvious way this can look broken. The cap
// below runs from +75 deg elevation all the way to the nadir and CLOSES there,
// so every direction with elevation < 75 deg hits it. There is no FOV, no pitch
// and no aspect ratio that can find a hole, because there is no hole.
//   The upper edge at +75 deg is the other half of that argument: the tallest
// ridge this shader can produce is NEAR_APEX 12 deg x apex 2.5 x (0.1 + 2 x 0.9)
// = 57 deg, so the geometry outruns the ridge by 18 deg at the extreme end of
// every slider. Widen the sliders and that margin is what you spend.
//
// Because the cap is recentred on the eye every frame, `normalize(position)` in
// the fragment shader is EXACTLY the view ray through that pixel -- the camera
// is at the centre of the sphere, so the ray to any point on the surface is the
// ray to that point. That is why a coarse 128x48 tessellation is enough: nothing
// is being interpolated except a direction, and the direction is exact.
//
// IT MUST WRITE DEPTH. Both the starfield and the aurora in this scene draw
// additively with depthWrite:false, depthTest:true, which puts them after the
// opaque pass and makes them rely on the depth buffer already being filled. If
// this material were transparent, or wrote no depth, stars and curtains would
// paint straight over the mountains and the horizon would vanish. So: opaque,
// depthWrite, depthTest, and `discard` above the ridge. The cost of the discard
// is that early-Z is off for this mesh -- fine, it is one shader with three
// noise evaluations and it fills at most half the screen.
//
// RIDGED MULTIFRACTAL, NOT FBM. Plain fbm of azimuth gives rounded lumps that
// read as a duvet. Folding each octave through 1 - |2n - 1| turns the noise's
// zero crossings into creases, and weighting each octave by the previous one
// (Musgrave's trick) keeps the fine detail on the ridges instead of sprinkling
// it evenly down the slopes. Three layers of it at different bearings and apex
// heights is what makes this read as depth rather than as a cut-out.
// ---------------------------------------------------------------------------

// Nearer than everything else in the lab. The sky dome and the starfield sit at
// 9000 and 15000, and the aurora's curtains live at 45 units/km x 86-110 km, so
// ~4000 out at the very closest. Anything in the 1000-2500 band is unambiguously
// in front of all three, and depth testing does the rest.
const RADIUS = 1500

const DEG = Math.PI / 180

// Apex heights, in degrees of elevation, for the three distance layers at
// apex = 1. Measured off the reference frames in mountain_silhouettes/: real
// skylines of this kind run 9-14 deg for the nearest wall and taper to about a
// third of that by the fourth or fifth layer.
const NEAR_APEX = 12
const MID_APEX = 8
const FAR_APEX = 5

// Ridge cells around the full 360 deg, per layer, as INTEGERS -- see the noise
// below, which wraps its lattice on this number so the skyline has no seam at
// due south. Nearer ridges subtend more, so they get fewer and broader peaks;
// the far layer is dense and fine, which is most of what sells its distance.
const NEAR_CELLS = 9
const MID_CELLS = 14
const FAR_CELLS = 23

// Each layer's floor, as a fraction of its own apex: the height the layer keeps
// at a bearing where its ridge function bottoms out.
//
// These are not cosmetic and a single shared value does not work -- it was 0.3
// for all three at first, and the result was a backdrop with one layer in it.
// The near layer's floor is 0.3 x 12 = 3.6 deg, which is above the far layer's
// 5 deg APEX, so the far range never once cleared the near range's valleys and
// simply never drew. A near range has to cut down to nearly nothing between its
// summits, because that notch is the only place anything behind it can be seen.
// So the floors run the other way from the apexes: deep valleys near, and a
// distant range that reads as a low, evenly serrated wall.
//
// Measured over four seeds at the default sliders, this splits the visible
// skyline 52 / 31 / 17 percent near / mid / far, with apexes landing at 11.6,
// 7.7 and 4.9 deg -- which is the layer census in mountain_silhouettes/.
const NEAR_BASE = 0.1
const MID_BASE = 0.2
const FAR_BASE = 0.45

const DEFAULTS = {
  apex: 1,
  relief: 1,
  haze: 0.35,
  rimAmount: 0,
  seed: 1,
  visible: true,
}

// Every hint below says what the knob costs or breaks, not what it is named.
export const BACKDROP_PARAMS = [
  {
    key: 'apex',
    label: 'Apex height',
    hint: 'Scales all three ridge lines about the horizon at once. Past about 1.8 the near wall eats the lower third of the sky and there is nowhere left for a low arc to sit.',
    type: 'float',
    min: 0.2,
    max: 2.5,
    step: 0.01,
    value: DEFAULTS.apex,
    uniform: false,
  },
  {
    key: 'relief',
    label: 'Relief',
    hint: 'Peak-to-peak swing above each layer\'s fixed base. At 0 the skyline becomes three flat walls, which is the quickest check that all three layers are actually drawing; above ~1.5 the near crests turn into spikes and start eating the sky.',
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    value: DEFAULTS.relief,
    uniform: false,
  },
  {
    key: 'haze',
    label: 'Aerial haze',
    hint: 'Lifts the mid and far layers toward the sky colour, which is the cue that separates them from the near wall. At 0 all three read as one silhouette; at 1 the far layer nearly disappears into the sky.',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    value: DEFAULTS.haze,
    uniform: false,
  },
  {
    key: 'rimAmount',
    label: 'Ridge backlight',
    hint: 'Scattered light along the crest, for testing whether a bright aurora should appear to spill over the skyline. Off by default because a rim with no aurora behind it looks like a rendering bug.',
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    value: DEFAULTS.rimAmount,
    uniform: false,
  },
  {
    key: 'seed',
    label: 'Ridge seed',
    hint: 'Redeals the whole skyline. Free -- it is one float into the hash -- so it is the cheapest way to check that a curtain looks right against more than one horizon.',
    type: 'float',
    min: 0,
    max: 100,
    step: 1,
    value: DEFAULTS.seed,
    uniform: false,
  },
  {
    key: 'visible',
    label: 'Show backdrop',
    hint: 'Drops the mesh from the scene entirely. Turn it off to see the parts of a curtain that normally sit below the horizon, which is where most of the shape errors hide.',
    type: 'bool',
    min: 0,
    max: 1,
    step: 1,
    value: DEFAULTS.visible,
    uniform: false,
  },
]

const VERT = `
  varying vec3 vDir;
  void main() {
    // Object space is world direction: the cap is translated to the eye and
    // never rotated or scaled, so position is already the ray from the
    // camera. Nothing here depends on the view matrix, which is the point --
    // the skyline is fixed to the world, not to the head.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const FRAG = `
  uniform float uApex;
  uniform float uRelief;
  uniform float uHaze;
  uniform float uRim;
  uniform float uSeed;
  uniform vec3 uRimColor;
  uniform vec3 uSkyTint;
  varying vec3 vDir;

  const float PI2 = 6.28318530718;

  // The colours are written as sRGB, because that is the space the reference
  // frames were sampled in and the space anyone reading this file will think
  // in. Every one of them goes through srgb() at the point of use, because the
  // shader itself works in linear. Getting that backwards is silently wrong
  // rather than obviously wrong: near black the gamma curve is steep, so an
  // sRGB value dropped straight into a linear pipeline comes out roughly four
  // times too dark -- and at these values, still entirely plausible.
  const vec3 NEAR_LO = vec3( 0.008, 0.016, 0.039 ); // #02040a
  const vec3 NEAR_HI = vec3( 0.020, 0.031, 0.063 ); // #050810
  const vec3 MID_LO  = vec3( 0.024, 0.043, 0.078 ); // #060b14
  const vec3 MID_HI  = vec3( 0.039, 0.071, 0.110 ); // #0a121c
  const vec3 FAR_LO  = vec3( 0.051, 0.086, 0.133 ); // #0d1622
  const vec3 FAR_HI  = vec3( 0.067, 0.110, 0.165 ); // #111c2a

  vec3 srgb( vec3 c ) { return pow( c, vec3( 2.2 ) ); }

  float hash11( float p ) {
    p = fract( p * 0.1031 );
    p *= p + 33.33;
    p *= p + p;
    return fract( p );
  }

  // Value noise on a lattice that WRAPS at the given period. The wrap is the
  // whole reason this is not a library call: azimuth is a circle, and a noise
  // that does not close on itself puts a vertical crack in the skyline at the
  // bearing atan() happens to discontinue at. Because every period below is an
  // integer and every octave doubles it, mod() lands exactly and the seam is
  // not merely hidden, it does not exist.
  float vnoise( float x, float period, float seed ) {
    float i = floor( x );
    float f = x - i;
    float u = f * f * ( 3.0 - 2.0 * f );
    float a = hash11( mod( i, period ) + seed );
    float b = hash11( mod( i + 1.0, period ) + seed );
    return mix( a, b, u );
  }

  // Three octaves of ridged multifractal over the bearing. Returns 0..1.
  //
  // 1 - |2n - 1| reflects the noise about its midline, so what were smooth zero
  // crossings become sharp creases; squaring widens the valleys and narrows the
  // crests, which is the asymmetry that separates rock from hills. Multiplying
  // each octave by the previous one is Musgrave's weighting: detail appears
  // only where there is already a ridge to carry it, so the flanks stay clean
  // instead of turning to gravel.
  float ridgeline( float turns, float cells, float seed ) {
    float sum = 0.0;
    float amp = 1.0;
    float norm = 0.0;
    float w = 1.0;
    float prev = 1.0;
    for ( int o = 0; o < 3; o++ ) {
      float period = cells * w;
      float n = vnoise( turns * period, period, seed + float( o ) * 19.19 );
      n = 1.0 - abs( n * 2.0 - 1.0 );
      n *= n;
      n *= prev;
      prev = clamp( n * 2.0, 0.0, 1.0 );
      sum += n * amp;
      norm += amp;
      amp *= 0.42;
      w *= 2.0;
    }
    return sum / norm;
  }

  // Elevation of one layer's crest at this bearing, in radians.
  //
  // A layer is a massif with a ridge riding on top of it: base is the massif,
  // and relief scales only the part above it. That split is what makes relief a
  // genuine peak-to-peak control rather than a second apex slider -- at relief
  // 0 each layer collapses to its own flat wall instead of to the horizon, and
  // the three walls stack visibly, which is a fast way to confirm the
  // compositing order is right.
  float layerHeight( float turns, float cells, float seed, float apexDeg, float base ) {
    float p = ridgeline( turns, cells, seed );
    return radians( apexDeg ) * uApex * ( base + uRelief * p * ( 1.0 - base ) );
  }

  void main() {
    // Exact, not approximate: the camera is at this sphere's centre, so the
    // vector to the fragment is the view ray through the pixel.
    vec3 dir = normalize( vDir );
    float elev = asin( clamp( dir.y, -1.0, 1.0 ) );

    // Bearing as 0..1 turns. atan(x, z) so that 0 is +z and the sense matches
    // the rest of the scene's compass.
    float turns = atan( dir.x, dir.z ) / PI2 + 0.5;

    float hNear = layerHeight( turns, ${NEAR_CELLS}.0, uSeed, ${NEAR_APEX}.0, ${NEAR_BASE} );
    float hMid  = layerHeight( turns, ${MID_CELLS}.0, uSeed + 31.7, ${MID_APEX}.0, ${MID_BASE} );
    float hFar  = layerHeight( turns, ${FAR_CELLS}.0, uSeed + 71.3, ${FAR_APEX}.0, ${FAR_BASE} );

    // Nearest wins, and the chain does the occlusion for free: a far ridge is
    // drawn only at bearings where it actually pokes above everything in front
    // of it, which is exactly what a far ridge does.
    // Initialised even though every path assigns them: a driver that flattens
    // this chain rather than branching will evaluate the tail of main() for a
    // discarded fragment, and reading an uninitialised float there is the kind
    // of thing that shows up as one vendor's garbage pixels and nobody else's.
    vec3 lo = NEAR_LO;
    vec3 hi = NEAR_HI;
    float crest = 0.0;
    float depth = 0.0;
    if ( elev < hNear ) {
      lo = NEAR_LO; hi = NEAR_HI; crest = hNear; depth = 0.0;
    } else if ( elev < hMid ) {
      lo = MID_LO; hi = MID_HI; crest = hMid; depth = 0.55;
    } else if ( elev < hFar ) {
      lo = FAR_LO; hi = FAR_HI; crest = hFar; depth = 1.0;
    } else {
      // Above every ridge: this is sky. Discarding rather than blending is what
      // keeps the depth buffer honest -- see the header. The edge is a hard
      // alpha-test edge and does alias, but the contrast across it is a few
      // 8-bit codes, so it costs less than the depth-sorting it avoids.
      discard;
    }

    // A slight vertical lift toward the crest. Flat silhouettes look like paper
    // cut-outs; real ones catch a little skylight on their upper slopes. The
    // -0.35 rad floor is well below any horizon the camera can see, so the
    // gradient never bottoms out inside the frame.
    float g = smoothstep( -0.35, crest, elev );
    vec3 col = srgb( mix( lo, hi, g ) );

    // Aerial perspective. The near layer is deliberately exempt: haze is a
    // function of the air between you and the thing, and there is none.
    col = mix( col, srgb( uSkyTint ), uHaze * depth * 0.6 );

    // Scattered light along the crest, for backlighting the skyline with a
    // strong aurora. Two thirds of a degree of falloff -- enough to read as
    // glow, narrow enough not to look like the mountains are on fire.
    float rim = smoothstep( crest - 0.012, crest, elev );
    col += srgb( uRimColor ) * rim * uRim;

    gl_FragColor = vec4( col, 1.0 );
    #include <colorspace_fragment>
  }
`

export class Backdrop {
  constructor(scene, opts = {}) {
    const init = { ...DEFAULTS, ...opts }

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uApex: { value: init.apex },
        uRelief: { value: init.relief },
        uHaze: { value: init.haze },
        uRim: { value: init.rimAmount },
        uSeed: { value: init.seed },
        // Not in the schema, because the sidebar has no colour widget. Both are
        // public and live -- see the `rimColor` / `skyTint` accessors below --
        // so the lab can point the rim at whatever the curtain is doing.
        //
        // sRGB components, like the layer colours in the shader, and converted
        // by the same srgb() call. Set them with `.setRGB(r, g, b)` or by
        // assigning .r/.g/.b, NOT with a THREE.Color hex constructor: that
        // would convert to linear on the way in and the shader would then
        // convert a second time, which mostly reads as "the rim is too dark".
        uRimColor: { value: new THREE.Color(0.35, 0.85, 0.55) },
        uSkyTint: { value: new THREE.Color(0.055, 0.086, 0.149) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Inside-out: the camera is inside the cap, so the outward-facing side is
      // the one facing away from us.
      side: THREE.BackSide,
      // Opaque, and it writes depth. The starfield and the aurora both draw
      // additively with depthWrite:false and depthTest:true, i.e. after the
      // opaque pass and against whatever depth the opaque pass left behind. If
      // this went transparent, or turned depthWrite off, both would paint over
      // the mountains and there would be no horizon at all. No renderOrder for
      // the same reason: the default opaque ordering is already correct.
      transparent: false,
      depthWrite: true,
      depthTest: true,
      fog: false,
    })

    // 15 deg from +Y down to the nadir: the cap starts at +75 deg elevation and
    // closes at the bottom pole. See the header for why the top edge is at 75
    // and why the bottom being CLOSED rather than merely low is the whole
    // no-gap guarantee.
    const geo = new THREE.SphereGeometry(RADIUS, 128, 48, 0, Math.PI * 2, 15 * DEG, 165 * DEG)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS)

    this.mesh = new THREE.Mesh(geo, this.material)
    // The cap moves with the eye every frame, so its world bounds are stale the
    // moment they are computed. Culling off rather than culling wrong.
    this.mesh.frustumCulled = false
    this.mesh.visible = init.visible
    scene.add(this.mesh)

    this._values = {
      apex: init.apex,
      relief: init.relief,
      haze: init.haze,
      rimAmount: init.rimAmount,
      seed: init.seed,
      visible: init.visible,
    }
  }

  // Live colour of the crest backlight. Only visible when rimAmount > 0.
  get rimColor() {
    return this.material.uniforms.uRimColor.value
  }

  // What the haze lifts the far layers toward. Should track the lab's sky.
  get skyTint() {
    return this.material.uniforms.uSkyTint.value
  }

  // Recentre on the eye. This camera only rotates, so in practice this is a
  // no-op after the first call -- but the shader's "position IS the view ray"
  // identity is only true while the cap is centred on the camera, and that is
  // too load-bearing to leave as an unwritten assumption about the host.
  update(head) {
    this.mesh.position.copy(head)
  }

  set(key, value) {
    const u = this.material.uniforms
    if (key === 'apex') u.uApex.value = value
    else if (key === 'relief') u.uRelief.value = value
    else if (key === 'haze') u.uHaze.value = value
    else if (key === 'rimAmount') u.uRim.value = value
    else if (key === 'seed') u.uSeed.value = value
    else if (key === 'visible') this.mesh.visible = value
    else throw new Error('Backdrop.set: unknown key ' + key)
    this._values[key] = value
  }

  get(key) {
    if (!(key in this._values)) throw new Error('Backdrop.get: unknown key ' + key)
    return this._values[key]
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
