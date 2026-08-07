import * as THREE from 'three'
import { SLOTS, PATTERNS, composeAuto, bandsFor } from './aurora-patterns.js'

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
//    ever. Nine overlapping bands in arbitrary draw order give the identical
//    frame. This is why the whole thing can be one BufferGeometry, and why
//    overlaying several named forms at once costs nothing structurally.
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
// of making this look real rather than like a green ribbon. The only two forms
// that override it are the two that are not precipitation at all -- the SAR arc
// and STEVE -- and they say so in aurora-patterns.js.
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
// hardware from 2011. Here it appears twice over: three noise octaves inside
// one band, and up to three overlaid named forms inside one sky.
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
// ONE SHADER, ONE MESH, TWELVE FORMS
// ===========================================================================
//
// The geometry here is deliberately CONTENTLESS: SLOTS identical parametric
// grids, each carrying nothing but (aU along, aV up, aSlot). Every number that
// makes a band a `drapery` rather than a `SAR arc` -- where it is, how tall,
// how folded, how rayed, what colour -- lives in a uniform array indexed by
// aSlot. Switching the whole sky is a write of 200 floats; nothing is rebuilt,
// nothing is recompiled, and there is exactly one shader program to debug.
//
// A slot whose brightness is zero collapses to a degenerate vertex outside the
// clip volume and is discarded before rasterisation, so an empty slot costs one
// early return and no fill. That is what makes carrying nine slots affordable
// when three are typically in use.
//
// ===========================================================================
// WHERE THE SHAPE COMES FROM
// ===========================================================================
//
// Everything that varies ALONG the band and is constant UP a column is computed
// in the VERTEX shader and interpolated -- column height, the flicker that
// makes columns come and go, the bottom-hem streaks, the lobe mask. That is not
// an optimisation detail, it is the field-alignment constraint again: these are
// all properties of a field line, and a field line is a column. Computing them
// per fragment would be both slower and wrong.
//
// It leaves the fragment shader with two noise evaluations, both for the
// striations, which is the budget §13 sets and the gate enforces.
//
// ===========================================================================
// SCALE AND PLACEMENT
// ===========================================================================
//
// Everything is built in KILOMETRES, because the physics is quoted in
// kilometres and a file full of 4050.0 would be unreadable. But the kilometres
// are then thrown away: the finished position is NORMALISED and placed on a
// shell of fixed radius. Only the DIRECTION survives.
//
// That is not an approximation, it is the removal of one. The aurora is
// sky-locked -- it follows the head with no parallax -- because at 100 km up,
// walking the entire 16 km world moves it under 5 degrees, and an aurora that
// slides past the mountains as she walks is precisely the wrong cue. Given no
// parallax and no stereo disparity (250 km is infinity to a 64 mm baseline),
// the true radius is unobservable. Everything you can see about an aurora is
// its direction and its colour.
//
// Keeping the true radius therefore bought nothing and cost the one thing that
// mattered: the far plane. At 45 units/km a 20000-unit far plane sits at 444
// km, so a band could not be further out than that, so its lower border could
// not be lower in the sky than about 13 degrees -- and the request was for
// arcs sitting ON the horizon, which needs a thousand kilometres and more.
// Three rounds of trimming folds and altitudes to fit inside 444 km were all
// paying for a number nobody could see.
//
// So: SHELL_UNITS, chosen to sit beyond every piece of terrain in the world
// (the 16 km world's far corner is 11,600 units from its centre) and well
// inside the far plane. Terrain occlusion still works, and works BETTER --
// every aurora fragment is now further away than every mountain, so the only
// thing that can hide an arc is a silhouette standing in front of it, which is
// the only thing that should.
//
// Depth still works, and does the right thing for free: the material is
// transparent, so it draws after the opaque pass has filled the depth buffer,
// with depthTest on and depthWrite off. A mountain in front of the aurora
// occludes it, and the geometry is far enough out and high enough up that this
// only happens where it should.
// ---------------------------------------------------------------------------

// Where the aurora shell sits, in world units. Any value between the far
// corner of the terrain (~11,600) and the far plane (20,000) gives the same
// image -- see SCALE AND PLACEMENT above for why the number is unobservable.
const SHELL_UNITS = 14000

// Samples along a band, and rows up it. 180 segments gives a fold wavelength of
// about 8 samples at the tightest wavelength the vertex shader displaces at,
// which is enough that the silhouette reads as a curve rather than a polyline.
const SEGS = 180
const ROWS = 10

// Rows are packed toward the bottom, because that is where the interesting
// part of the deposition profile is: the lower border is a knife edge and the
// top is a long smooth fade, so uniform spacing would waste half the rows on
// the half of the profile that has no features.
const ROW_BIAS = 1.6

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
// as a vec2: x sideways along the footprint NORMAL (toward and away from the
// viewer), y along the footprint TANGENT (forward and back along the band).
//
// ===========================================================================
// WHY THERE ARE TWO COMPONENTS, WHICH IS THE WHOLE OF ROUND FIVE
// ===========================================================================
//
// Until now this returned one number and the vertex shader wrote
//
//     p = dir * ( dist + fold ) + up * alt
//
// which is a POLAR GRAPH: radius as a function of azimuth. A polar graph is
// single-valued in its angle by construction, so no amount of amplitude can
// make the footprint double back on itself. It can wander toward and away from
// the viewer -- which perspective turns into a hem that rises and falls -- but
// two parts of the same band can never be at the same bearing, and therefore
// the curtain can never fold back over itself or overlap itself. It flaps; it
// does not fold. That was the reported complaint and it was a property of this
// one line, not of the shader, the hardware or the technique.
//
// Adding a TANGENTIAL component turns the footprint into a general parametric
// curve in the ground plane, and a general curve may loop. Concretely: walking
// the band, the along-track speed is 1 + d(tangential)/d(km). Where that goes
// negative the track REVERSES -- the same stretch of sky gets two pieces of
// curtain, one behind the other, which is exactly the shape in every
// photograph of a folded arc, and exactly what an optically thin additive
// emitter should do when it happens (the two layers add, and the fold is
// brighter, which is also what the photographs show).
//
// The tangential octaves are the SAME noise sampled a quarter wavelength
// along. A quarter-wave phase offset between two components is a circle -- so
// each octave contributes a loop rolled along the band, which is the trochoid
// family, and is what an auroral curl or spiral actually is. Using independent
// noise instead gives a curve that wanders in two axes without ever closing,
// which reads as jitter rather than as coiling.
//
// `curl` is the tangential amplitude relative to the normal one, and it is
// allowed past 1. It has to be: the normal component is what the fold costs in
// apparent DEPTH, which the eye reads as very little at 300 km, while the
// tangential component is free and does all of the visible work. A form with
// curl 0 is exactly the old behaviour.
//
// Four octaves at rates that are not integer multiples of each other -- this
// is Skyrim's three-layer trick, moved from UV scroll onto the fold amplitude.
// The time term is INSIDE the noise rather than added to the coordinate, which
// is the whole difference: adding to the coordinate slides the pattern along
// the band, putting it in the second axis makes the pattern MORPH IN PLACE.
// Real folds do the latter.
const FOLD_GLSL = `
  // Rates: the three structural octaves were slowed by about a third when the
  // tangential term went in. A fold that comes and goes in eight seconds reads
  // as flicker; the same fold over twelve or fifteen seconds reads as the sheet
  // winding and unwinding, which is the motion an aurora actually has. The
  // fourth octave was left fast on purpose -- that one is the breakup flicker,
  // it is gated on activity, and it is supposed to be quick.
  vec2 aurFold( float km, float t, float amp, float hz, float act, float curl, float ms ) {
    // The MEANDER, and it is the longest octave by a factor of four. A band
    // whose largest structure is its fold wavelength runs across the sky as a
    // near-straight line with texture on it -- which is what an auroral arc
    // does NOT do. Real arcs snake: one or two enormous swings across the
    // whole visible span, with the folds riding on top of them.
    //
    // Deliberately NOT multiplied by hz. hz is a form's fold CHARACTER -- tight
    // curls at 3.1, long lazy drapery at 0.3 -- and the meander is a property
    // of the oval rather than of the form, so a curl band snakes on exactly
    // the same scale a drapery does. Weighting it 2.30 against the base
    // octave's 1.0 is what makes it the shape the eye reads first.
    //
    // It IS multiplied by 'ms', which normalises it to a 250 km reference
    // band. The meander is the only octave measured in DEGREES OF SKY rather
    // than in kilometres, and it has to be: a 1000 km arc low on the horizon
    // has the same 294 km of meander as a 250 km one overhead, so without this
    // it would show four times as many swings across the same span of sky and
    // would read as texture rather than as a course. Everything else -- folds,
    // curls, rays, the hem -- stays metric, because those are real lengths and
    // really do get finer with distance.
    float mkm = km * ms;
    float q   = 73.5;       // a quarter wavelength of the meander, in mkm
    vec2 f = vec2( aurNoise( vec2( mkm * 0.0034,             t * 0.014 ) ),
                   aurNoise( vec2( ( mkm + q ) * 0.0034,     t * 0.014 ) ) ) - 0.5;
    f *= 2.30;
    f += ( vec2( aurNoise( vec2( km * 0.0125 * hz,                   t * 0.038 ) ),
                 aurNoise( vec2( ( km + 20.0 / hz ) * 0.0125 * hz,   t * 0.038 ) ) ) - 0.5 ) * 1.0;
    f += ( vec2( aurNoise( vec2( km * 0.0410 * hz,                   t * 0.085 ) ),
                 aurNoise( vec2( ( km + 6.1 / hz ) * 0.0410 * hz,    t * 0.085 ) ) ) - 0.5 ) * 0.52;
    // The fourth octave is gated on activity. A quiet aurora is a smooth arc;
    // the fine curls only appear at breakup. That progression -- arc, then
    // folds, then curls -- is the Akasofu substorm sequence, and animating it
    // is most of why standing and watching this is worth doing.
    f += ( vec2( aurNoise( vec2( km * 0.1350 * hz,                   t * 0.310 ) ),
                 aurNoise( vec2( ( km + 1.85 / hz ) * 0.1350 * hz,   t * 0.310 ) ) ) - 0.5 )
         * 0.34 * act;
    return vec2( f.x, f.y * curl ) * amp;
  }
`

function buildGeometry() {
  const aU = []
  const aV = []
  const aSlot = []
  const idx = []
  // position exists only because three requires it; every coordinate is
  // computed in the vertex shader from the band uniforms.
  const pos = []

  for (let s = 0; s < SLOTS; s++) {
    const base = aU.length
    for (let i = 0; i <= SEGS; i++) {
      for (let k = 0; k < ROWS; k++) {
        aU.push(i / SEGS)
        aV.push(Math.pow(k / (ROWS - 1), ROW_BIAS))
        aSlot.push(s)
        pos.push(0, 0, 0)
      }
    }
    for (let i = 0; i < SEGS; i++) {
      for (let k = 0; k < ROWS - 1; k++) {
        const a0 = base + i * ROWS + k
        const b0 = base + (i + 1) * ROWS + k
        idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1))
  geo.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 1))
  geo.setAttribute('aSlot', new THREE.Float32BufferAttribute(aSlot, 1))
  geo.setIndex(idx)
  // Every vertex ends up on the shell, so the bounding sphere is the shell.
  // (frustumCulled is false anyway -- this is here so anything that reads the
  // bounds, a raycast or a debug helper, gets an honest answer.)
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SHELL_UNITS)
  return geo
}

export class Aurora {
  constructor(scene, { seed = 0 } = {}) {
    this.seed = seed
    // -1 is the composer; 0..PATTERNS.length-1 pins one named form, which is
    // what the J key cycles through.
    this.pattern = -1
    this.live = []

    // One vec4 array per four parameters. Grouped by what they do rather than
    // by type, so a row of this table reads like the row in aurora-patterns.js
    // it came from.
    const arr = (n) => new Float32Array(SLOTS * n)
    this.bandA = arr(4) // dist, azDeg, spanDeg, bright
    this.bandB = arr(4) // alt0, alt1, fold, foldHz
    this.bandC = arr(4) // speed, drift, ray, rayHz
    this.bandD = arr(4) // lobes, ragged, flick, fringe
    this.bandE = arr(4) // pulse, tintAmt, seed, --
    this.bandF = arr(4) // pale, crown, shear, breathe
    this.bandG = arr(4) // twist, flame, curl, --
    this.bandT = arr(3) // tint rgb

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uActivity: { value: 0 },
        uBandA: { value: this.bandA },
        uBandB: { value: this.bandB },
        uBandC: { value: this.bandC },
        uBandD: { value: this.bandD },
        uBandE: { value: this.bandE },
        uBandF: { value: this.bandF },
        uBandG: { value: this.bandG },
        uBandT: { value: this.bandT },
      },
      vertexShader: `
        attribute float aU;
        attribute float aV;
        attribute float aSlot;

        uniform float uTime;
        uniform float uActivity;
        uniform vec4 uBandA[ ${SLOTS} ];
        uniform vec4 uBandB[ ${SLOTS} ];
        uniform vec4 uBandC[ ${SLOTS} ];
        uniform vec4 uBandD[ ${SLOTS} ];
        uniform vec4 uBandE[ ${SLOTS} ];
        uniform vec4 uBandF[ ${SLOTS} ];
        uniform vec4 uBandG[ ${SLOTS} ];
        uniform vec3 uBandT[ ${SLOTS} ];

        varying vec4 vShape; // altitude km, along-band km, this column's top km, its base km
        varying vec4 vMod;   // envelope, bottom-hem streak, ray contrast, ray frequency
        varying vec4 vTint;  // colour override rgb + how much of it
        varying vec4 vCol;   // palette: paleness, crown strength, base softness, flame
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vBright;

        ${NOISE_GLSL}
        ${FOLD_GLSL}

        void main() {
          int s = int( aSlot + 0.5 );
          vec4 A = uBandA[ s ];

          // An unused slot collapses to a point outside the clip volume, so its
          // triangles are discarded before they cost a single fragment. This is
          // what lets nine slots exist for the sake of three.
          if ( A.w < 0.0015 ) {
            gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
            return;
          }

          vec4 B = uBandB[ s ];
          vec4 C = uBandC[ s ];
          vec4 D = uBandD[ s ];
          vec4 E = uBandE[ s ];
          vec4 F = uBandF[ s ];
          vec4 G = uBandG[ s ];

          vBright = A.w;
          vTint = vec4( uBandT[ s ], E.y );

          float t = uTime * C.x + E.z * 41.0;

          // ---- Distance along the footprint from its centre, in km, plus the
          // slow translation. Real arcs drift -- usually westward before
          // midnight -- and the drift is applied to the SHAPE coordinate so the
          // whole structure travels together rather than the pattern sliding
          // through a stationary silhouette.
          //
          // This is computed BEFORE the footprint azimuth, which is a reversal
          // of the obvious order and is deliberate: the azimuth now depends on
          // altitude (see 'twist' below), altitude depends on the per-column
          // terms, and every one of those is a function of 'km'. 'km' itself
          // depends only on aU, so it is the one thing that can come first.
          float km = ( aU - 0.5 ) * radians( A.z ) * A.x + uTime * C.y;

          // How many kilometres along this band make up one kilometre's worth
          // of ANGLE at the 250 km reference distance. The two structures whose
          // size the eye judges in degrees rather than in kilometres -- the
          // meander and the swoop -- are measured in these units instead. A
          // 1000 km arc on the horizon then shows the same number of long
          // swings across the same span of sky as a 250 km one overhead, which
          // is the difference between reading as a course and reading as fuzz.
          float mScale = 250.0 / A.x;

          // ================================================================
          // Per-column terms. Constant up a field line, so they belong here.
          // ================================================================

          // How tall THIS column reaches. Without this every band tops out at
          // exactly the same altitude and the result is a rectangle -- the
          // single most artificial thing a procedural aurora does.
          float ragged = aurNoise( vec2( km * 0.026, t * 0.07 ) );
          float topF = 1.0 - D.y * ( 1.0 - ragged );
          float topKm = B.x + ( B.y - B.x ) * mix( 0.30, 1.0, topF );

          // The lower border wanders only slightly: it is set by where
          // electrons of a given energy stop, and that is the most uniform
          // thing about an aurora. A few km, no more.
          float baseKm = B.x + ( aurNoise( vec2( km * 0.05, t * 0.05 ) ) - 0.5 ) * 5.0;

          // ---- The SWOOP: the whole column rides up and down on a wavelength
          // of about 240 km, so the hem crosses the sky as a long serpentine
          // curve instead of as a level line with texture on it.
          //
          // Why this exists as well as the meander in aurFold: the meander
          // moves the band toward and away from the viewer, and perspective
          // turns that into a rise and fall of the hem -- which is the honest
          // mechanism, and it is how a real curtain's hem swoops. But its
          // amplitude is bounded by the far plane (a band 250 km out cannot
          // fold 60 km outward and stay inside a 444 km camera), and at the
          // distances these bands sit at, perspective alone buys about two
          // degrees. So the swoop does the same job along the axis that costs
          // nothing: the column slides bodily up and down, base and top
          // together, which leaves the deposition curve untouched because it
          // is normalised to the column's own height.
          //
          // Amplitude is tied to 'fold', so a form has ONE knob for how
          // sinuous it is rather than two that have to be kept in agreement --
          // but CAPPED, which the raw tie is not. The far bands now carry folds
          // of 60-130 km, and a hem sliding 60 km up and down is not a swoop,
          // it is the band leaving the altitude range that gives it its colour:
          // 557.7 nm green needs 100-150 km, and there is nothing at all below
          // 80. 26 km of fold is what the old near-only catalogue ran at, so
          // +/- 13 km is the excursion this was tuned against in the first
          // place.
          float swoop = ( aurNoise( vec2( km * 0.0042 * mScale + E.z * 1.7, t * 0.026 ) ) - 0.5 )
                        * min( B.z, 26.0 );
          baseKm += swoop;
          topKm += swoop;

          // Columns come and go. A band whose every column is permanently lit
          // reads as a painted object; a real one is continually rebuilt out of
          // rays that live for a few seconds each.
          float fl = aurNoise( vec2( km * 0.055, t * 0.33 ) );
          float flick = mix( 1.0, smoothstep( 0.24, 0.74, fl ), D.z );

          // The bottom hem, which is the part the eye is drawn to. High spatial
          // frequency and fast, so the base breaks into short vertical streaks
          // that fade in and out independently of the band above them.
          float fr = aurNoise( vec2( km * 0.28, t * 0.55 ) ) * 0.65
                   + aurNoise( vec2( km * 0.90, t * 0.90 ) ) * 0.35;
          float fringe = mix( 1.0, smoothstep( 0.32, 0.80, fr ), D.w );

          // How gradually the lower border fades in, as a fraction of this
          // column's own height, and it is per-column on purpose. A single
          // global softness turns the hem into a blurred straight line, which
          // is the same fabric-curtain tell as a sharp one. Tying it to the
          // hem noise means the columns that flare brightest are also the
          // crispest, and the ones fading out feather away -- so the bottom
          // edge is a ragged gradient rather than an edge at all.
          float soft = mix( 0.08, 0.26, fr );

          // Break the band into discrete blobs, for the diffuse and pulsating
          // forms. With lobes = 0 the noise argument is constant and the mix
          // selects 1.0, so a continuous band pays for one lookup and no
          // branch.
          float ln = aurNoise( vec2( aU * D.x + E.z, t * 0.09 ) );
          float lobe = mix( 1.0, smoothstep( 0.30, 0.66, ln ), step( 0.5, D.x ) );

          // Pulsating patches: each blob on its own beat, phase taken from
          // along-band noise. The whole sky flashing in unison is the failure
          // mode here and it looks like a broken light.
          float ph = aurNoise( vec2( km * 0.09, E.z ) ) * 6.2832;
          float pulse = mix( 1.0, 0.30 + 0.70 * ( 0.5 + 0.5 * sin( uTime * E.x * 6.2832 + ph ) ),
                             step( 0.001, E.x ) );

          // ---- Presence. The deepest of the envelopes, and the one that
          // decides whether a stretch of band is in the sky at all right now.
          //
          // TWO octaves, because one could not do both halves of the job:
          //
          //   REGION (~360 km, a couple of minutes) is which stretch of the
          //     oval is switched on at all. Slow enough to watch happen, and
          //     long enough that its boundaries are hundreds of km of gradient
          //     rather than an edge.
          //   WASH (~145 km, and five times faster) rolls across whatever the
          //     region left lit. This is the one that makes the shape hard to
          //     read: parts of a band brighten and dissolve while you are
          //     still working out where it ends.
          //
          // Both are deliberately LONGER in space than anything else in the
          // shader -- flick is 18 km, the fringe is 3 km, the folds are tens.
          // The first version of this ran at 48 km, which is short enough that
          // a band came out as one small lit patch with hard shoulders: a
          // confined triangle rather than a curtain fading into the dark. The
          // blur radius of an envelope is its wavelength, and the fix for a
          // narrow blur is a longer wave, not a softer curve.
          //
          // They MULTIPLY rather than sum. Summed, two envelopes average each
          // other out and the result sits near its mean; multiplied, either
          // one can veto, which is what "mostly absent, occasionally blazing"
          // actually is. Region enters squared, so its dark half is very dark.
          //
          // The seed offsets matter: without them every band in the sky shares
          // one envelope at a given 'km' and they all fade in unison, which
          // reads as the renderer dimming rather than as weather.
          float macA = aurNoise( vec2( km * 0.0028 + E.z * 0.7, t * 0.052 ) );
          float macB = aurNoise( vec2( km * 0.0069 + E.z * 2.3, t * 0.285 ) );
          float region = smoothstep( 0.18, 0.88, macA );
          float wash = smoothstep( 0.06, 0.94, macB );
          float presence = mix( 1.0, 0.08 + 2.55 * region * region * ( 0.22 + 0.78 * wash ), F.w );

          // And one breath for the band as a whole, so entire forms come and
          // go rather than only parts of them. Constant along the band -- the
          // argument is the band's own seed -- so it cannot fight the spatial
          // term above, it only scales it.
          float breath = mix( 1.0, 0.25 + 0.75 * aurNoise( vec2( E.z * 7.3, t * 0.017 ) ), F.w );

          // ---- Plan envelope. A 30% taper at each end rather than 14%, and a
          // separate, wider taper on the column HEIGHT, so a band is a lens in
          // silhouette instead of a rectangle with soft edges. The two together
          // are what make overlaid forms read as separate blobs of light rather
          // than as stacked ribbons.
          //
          // The height taper floors at 0.58 rather than 0.40. At 0.40 the ends
          // of a band were short enough that, once the presence envelope had
          // taken the middle out, what was left read as a wedge with a corner
          // on it. A band should fade out, not taper to a point.
          float endTaper = smoothstep( 0.0, 0.30, aU ) * smoothstep( 1.0, 0.70, aU );
          float ovality = mix( 0.58, 1.0,
                               smoothstep( 0.0, 0.44, aU ) * smoothstep( 1.0, 0.56, aU ) );
          topKm = baseKm + ( topKm - baseKm ) * ovality;

          // ================================================================
          // Position
          // ================================================================
          float alt = mix( baseKm, topKm, aV );

          // ---- Footprint. A circular arc centred on the viewer, which is what
          // an auroral arc looks like from underneath: the oval is thousands of
          // km across, so the near part of it reads as a band crossing the sky
          // rather than as a ring.
          //
          // TWIST (G.x, degrees of azimuth per km of altitude) is what makes
          // the vortex forms actually three-dimensional, and it is the piece
          // 'shear' alone could not give. Shear moves the point at which the
          // fold noise is sampled, so a column LEANS -- its pattern is offset
          // with height, but the sheet it lives on is still a flat vertical
          // ribbon standing on a fixed ground track. Rotating the azimuth with
          // altitude moves the GEOMETRY: the ground track at 260 km sits tens
          // of degrees around the sky from the ground track at 96 km, and the
          // band between them is a helix. That is a shape you can walk around
          // and see turn, which a leaning sheet is not.
          //
          // At 0.18 deg/km -- the default, and the real dip of the field at
          // 65 N expressed as rotation rather than as lean -- a 150 km column
          // rotates 27 degrees, which is the slight corkscrew every tall rayed
          // band has. Past about 0.3 it stops being a curtain.
          float a = radians( A.y + ( aU - 0.5 ) * A.z + G.x * ( alt - baseKm ) );
          vec3 dir = vec3( sin( a ), 0.0, -cos( a ) );   // north is -z, east is +x
          vec3 tng = vec3( cos( a ), 0.0, sin( a ) );

          // Fold amplitude grows with altitude. Field lines converge downward,
          // so a fold is tighter at the bottom edge and splays out above -- it
          // is why curtains look like curtains and not like walls.
          //
          // The floor is 0.86 rather than 0.55: at 0.55 the BASE of a band
          // barely folded at all, so however much the top writhed the hem
          // stayed a level line. The splay is still there, it just no longer
          // starts from nothing.
          float amp = B.z * ( 0.86 + ( alt - 90.0 ) * 0.0042 );

          // Field lines are not vertical. At 65 N the magnetic dip is about 78
          // degrees, so the top of a 150 km column sits some 30 km along-band
          // from its own base -- and since the fold pattern is carried BY the
          // field lines, the fold at the top is the fold from further along.
          // That is the lean you see in every photograph of a tall rayed band,
          // and it is what twist above cannot give: twist turns the ribbon,
          // shear slides the pattern along it, and a vortex needs both.
          float shear = F.z * ( alt - baseKm );
          // The meander runs in degrees of sky, not kilometres -- see aurFold.
          float mScale = 250.0 / A.x;
          vec2 f0 = aurFold( km + shear, t, amp, B.w, uActivity, G.z, mScale );

          // Surface normal by finite difference along the footprint. Two extra
          // noise evaluations per vertex, and the payoff is the edge-on
          // brightening in the fragment shader, which is the effect that turns
          // a smooth ribbon into distinct bright rays. Without a correct normal
          // here that effect points the wrong way and looks worse than nothing.
          //
          // Both components enter the difference now. The along-track term is
          // ( dk + f1.y - f0.y ), and where the curl is strong enough that goes
          // NEGATIVE -- the fold has doubled back, and the tangent, and with it
          // the normal, flips. That is correct and it is also harmless: the
          // fragment shader only ever uses this normal inside abs(), because an
          // optically thin emitter has no front and no back.
          float dk = 2.0;
          vec2 f1 = aurFold( km + shear + dk, t, amp, B.w, uActivity, G.z, mScale );
          vec3 tanW = normalize( tng * ( dk + f1.y - f0.y ) + dir * ( f1.x - f0.x ) );
          // The sheet is vertical, so its normal is the plan tangent turned 90
          // degrees about up.
          vNrm = normalize( vec3( -tanW.z, 0.0, tanW.x ) );

          vShape = vec4( alt, km, topKm, baseKm );
          vMod = vec4( endTaper * lobe * flick * pulse * presence * breath, fringe, C.z, C.w );
          vCol = vec4( F.x, F.y, soft, G.y );

          // The footprint, in kilometres, as a general parametric curve rather
          // than as a polar graph -- the tangential term is what lets it turn
          // back on itself.
          float gd = A.x + f0.x;

          // ---- And the Earth is round, which at these distances is the single
          // biggest thing acting on where a band appears in the sky.
          //
          // The ground under an aurora 1000 km away has fallen 78 km below the
          // tangent plane you are standing on, so a band whose base is at 101
          // km altitude is only 23 km above YOUR horizontal -- 1.3 degrees up,
          // not the 5.8 that flat ground would give. Past about 1130 km the
          // base has gone under the horizon entirely and you see only the tops
          // of the rays, which is exactly the sight the request described:
          // an aurora coming up from below the horizon. Every photograph of a
          // distant arc is showing this and nothing else.
          //
          // d^2 / 2R with R = 6371 km, so 12742. It is applied ONLY here, to
          // the position; vShape carries the true altitude, because altitude is
          // what sets the colour and the deposition profile and neither of
          // those cares where the observer is standing.
          //
          // Note it uses gd, not A.x -- the fold is included. At 1180 km the
          // drop changes by 0.19 km for every km of fold, so a band folding 60
          // km further out sinks another 11 km, and the hem weaves across the
          // horizon line of its own accord. That undulation is free, and it is
          // the honest version of what the swoop above approximates.
          float drop = gd * gd / 12742.0;

          vec3 p = dir * gd + tng * f0.y + vec3( 0.0, alt - drop, 0.0 );

          // ...and then the kilometres are discarded and only the bearing is
          // kept. See SCALE AND PLACEMENT at the top of the file: an aurora has
          // no parallax and no stereo disparity, so its distance is not an
          // observable, and pinning it to a shell buys back the far plane. A
          // band at 1,400 km with its hem 4 degrees above the horizon costs
          // exactly what one at 250 km overhead costs, which is what makes the
          // low arcs possible at all.
          vec4 world = modelMatrix * vec4( normalize( p ) * ${SHELL_UNITS.toFixed(1)}, 1.0 );
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform float uActivity;

        varying vec4 vShape;
        varying vec4 vMod;
        varying vec4 vTint;
        varying vec4 vCol;
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vBright;

        ${NOISE_GLSL}

        void main() {
          float alt = vShape.x;
          float km  = vShape.y;
          // Height up THIS column, 0 at its own base and 1 at its own ragged
          // top. Normalising here is what lets one deposition curve serve a
          // 30 km picket fence and a 90 km SAR arc.
          float h = ( alt - vShape.w ) / max( vShape.z - vShape.w, 1.0 );

          // ---- Deposition: how brightly the gas glows at this height.
          //
          // Three terms, and each one is a piece of the real silhouette:
          //   the smoothstep is the LOWER BORDER -- electrons of a given energy
          //     penetrate to a definite depth and stop, so the bottom edge of an
          //     aurora is startlingly sharp, sharper than anything else in the sky;
          //   the exponential is the tail of the energy spectrum thinning upward;
          //   the last smoothstep takes it to EXACTLY ZERO before the mesh ends.
          //
          // That third term is not physics, it is honesty about geometry. A
          // deposition curve that is still non-zero at the top row draws the
          // top row -- and a row of triangles is a straight line, which is
          // precisely the hem-of-a-fabric-curtain look this has to avoid. The
          // top of an aurora has no edge at all; it dissolves.
          // The lower border is genuinely the sharpest edge in the sky -- but
          // "sharp" is a physical statement about a few km of altitude, and at
          // the scale of a 150 km column that is still a gradient. Drawn as a
          // 5%-of-height step it came out as a hem: a hard line with texture
          // hanging off it. vCol.z is the per-column width from the vertex
          // shader, 8% to 26%, so the bottom dissolves the way the top and the
          // sides do and no two columns end at the same place.
          float dep = smoothstep( 0.0, vCol.z, h )
                    * exp( -h * 2.0 )
                    * smoothstep( 1.0, 0.34, h );

          // The bottom hem breaks into vertical streaks that come and go. Only
          // the lowest fifth of the column: higher up the rays merge.
          dep *= mix( vMod.y, 1.0, smoothstep( 0.0, 0.30, h ) );

          // ---- Flaming: waves of brightness racing UP the field lines.
          //
          // This is the ONE altitude term in the whole shader, and it is here
          // on purpose rather than by accident. The rule the header states --
          // no height in the noise -- is about STRUCTURE: rays, folds and
          // striations are carried by the field lines and must therefore be
          // constant up a column, and a height term in any of those turns the
          // aurora into coloured fog. Flaming is not structure. It is a
          // disturbance PROPAGATING along a field line, and the thing that
          // moves is brightness, not shape. So the wave rides on 'dep', which
          // is already a function of height, and nothing that defines the
          // form's silhouette can see it.
          //
          // The previous attempt made this out of the shear instead: a large
          // shear plus a negative drift does slide the fold pattern upward,
          // and the arithmetic was right, but what travels is the FOLD, and a
          // fold moving up a column that is already twisting is not something
          // the eye can pick out. There was no light racing anywhere.
          //
          // Cubed, so it is mostly dark with a narrow bright crest -- a wave
          // rather than a sine glow. The phase offset along the band is what
          // stops it being a full-sky strobe: at 115 km per cycle, adjacent
          // stretches of the same band are out of step, so the crests run up
          // in ragged succession instead of the sky flashing in unison.
          float wave = 0.5 + 0.5 * sin( ( h * 2.8 - uTime * 1.1 ) * 6.2832 + km * 0.055 );
          dep *= mix( 1.0, 0.20 + 1.90 * pow( wave, 3.0 ), vCol.w );

          // ---- Colour by altitude, and by nothing else. See the header. The
          // override is for the two forms that are not precipitation.
          //
          // Two knobs per band, and between them they cover every colour a real
          // aurora comes in, because both of them are ratios between the same
          // three emission lines rather than free hue choices:
          //
          //   pale (vCol.x) is how hard the precipitation is. Harder
          //     electrons excite the N2 band systems alongside the atomic
          //     lines, which whitens the 557.7 green toward mint and pulls the
          //     hem from N2+ violet toward its own 427.8 nm blue. One knob,
          //     because it is one cause: at 0 this is the classic green-and-
          //     violet, at 1 it is the pale alien green with an electric blue
          //     base.
          //   crown (vCol.y) is how much soft, slow 630.0 nm sits on top.
          //     The target is magenta rather than pure red because that is
          //     what the eye and the camera get: 630.0 red arriving through
          //     the same column as the 427.8 blue underneath it. This is the
          //     "purple curtain above the green one" of the photographs.
          vec3 violet = mix( vec3( 0.62, 0.18, 0.72 ),   // N2+ 428 nm
                             vec3( 0.18, 0.60, 1.00 ),   // N2+ 427.8, electric blue
                             vCol.x );
          vec3 green  = mix( vec3( 0.14, 1.00, 0.44 ),   // OI 557.7 nm
                             vec3( 0.56, 1.00, 0.84 ),   // whitened by the N2 bands
                             vCol.x );
          vec3 col = mix( violet, green, smoothstep( 92.0, 111.0, alt ) );
          col = mix( col, vec3( 1.00, 0.20, 0.46 ),      // OI 630.0 over the blue hem
                     clamp( smoothstep( 155.0, 235.0, alt ) * 0.85 * vCol.y, 0.0, 0.95 ) );
          col = mix( col, vTint.rgb, vTint.a );

          // ---- Rays: vertical striations, a function of ALONG-BAND position
          // only.
          //
          // This is the field-alignment constraint from the header, expressed
          // as one missing term: there is no height anywhere in this noise
          // lookup, so every ray runs perfectly vertically from the bottom edge
          // to the top, exactly as electrons do. Adding a height term here
          // would be one character and would destroy the effect.
          //
          // Two octaves, and two is the budget: ~1.4 km fine structure and
          // ~8 km clumping, which are about the real spacings.
          float t = uTime * 0.5;
          float ray = aurNoise( vec2( km * 0.72 * vMod.w, t * 0.9 ) ) * 0.62
                    + aurNoise( vec2( km * 0.13 * vMod.w, t * 0.4 ) ) * 0.38;
          // Rays are crisp at the bottom and blur out higher up, because the
          // emitting region spreads as the field lines diverge.
          float crisp = mix( 1.0, 0.25, smoothstep( 0.30, 1.0, h ) );
          ray = mix( 1.0, ray * 1.9, vMod.z * ( 0.40 + 0.60 * uActivity ) * crisp );

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
          // Clamped, not left to blow up: an exactly edge-on polygon is a
          // division by zero and a line of fireflies across the sky.
          vec3 view = normalize( vWorld - cameraPosition );
          float grazing = clamp( 1.0 / max( abs( dot( view, normalize( vNrm ) ) ), 0.16 ), 1.0, 4.2 );

          // ---- Atmospheric extinction near the horizon. The far arcs' bases
          // sit low, and light from them crosses a great deal of air.
          //
          // Widened and dropped once the curvature term put real bands at and
          // below the horizon line. The old window reached full brightness by 8
          // degrees and cut off at -1.7, which was fine when nothing was
          // catalogued below 13; against the present catalogue it would have
          // deleted the picket fence and most of the far arcs outright. Now: a
          // hem sitting exactly on the horizon is a fifth as bright, full
          // strength arrives by about 6 degrees, and anything that has sunk
          // below -2.9 degrees is gone -- which is also what keeps a band whose
          // base is under the horizon from being drawn through the ground.
          float ext = smoothstep( -0.05, 0.10, view.y );

          // 0.80 rather than 0.46 because vMod.x now carries the presence
          // envelope, whose typical value is about 0.3. Net effect: an average
          // moment is a little under half as bright as it was, and the rare
          // ones are three times brighter than it ever got.
          float a = dep * ray * grazing * ext * vMod.x * vBright * uIntensity * 0.80;

          gl_FragColor = vec4( col * max( a, 0.0 ), 1.0 );
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      // Additive, and therefore order-independent -- see note 2 in the header.
      // This is why nine interpenetrating bands can live in one draw call with
      // no sorting, and why forms can be overlaid at will.
      blending: THREE.AdditiveBlending,
      // Depth tested, never written. The transparent pass runs after the opaque
      // one, so the depth buffer already holds the terrain: mountains occlude
      // the aurora, and the aurora never occludes itself.
      depthWrite: false,
      depthTest: true,
      // Bands are two-sided; you can walk under one and look back.
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
    // nothing at noon and costing a transparent pass at noon.
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  // The cycle runs auto, then each named form in turn, then back to auto -- one
  // key, and every form reachable, which is what makes this a debugging tool
  // and not just a toy. Internally -1 is auto, so shift into 0..N and back.
  cyclePattern(dir = 1) {
    const n = PATTERNS.length + 1
    this.pattern = (((this.pattern + 1 + dir) % n) + n) % n - 1
    return this.pattern
  }

  setPattern(i) {
    if (!(i >= -1 && i < PATTERNS.length)) throw new Error(`no aurora pattern ${i}`)
    this.pattern = i
    return this.pattern
  }

  // What the HUD prints. In auto mode this is what the composer actually chose,
  // which is the only way to know why the sky looks the way it does.
  get label() {
    if (this.pattern >= 0) return `[${this.pattern + 1}/${PATTERNS.length}] ${PATTERNS[this.pattern].name} -- pinned`
    if (this.live.length === 0) return 'auto -- nothing up'
    // Only what you could actually see. A form crossfading in at 0.004 is in
    // the live set and is honestly reported by the console log, but printing
    // "pulsating patches 0.00" on the HUD is noise, and four entries overflows
    // the panel's 1024 px at 26 px monospace.
    // ...and only as many as fit. The panel is 1024 px wide with a 22 px
    // margin, drawn at 26 px in a monospace whose advance is 0.60 em, so the
    // line budget is (1024 - 44) / 15.7 = 62 characters. Four forms is 98:
    // "diffuse patches 0.89, pulsating patches 0.25, smoke plume 0.21,
    // multiple arcs 0.20". Budgeting by width rather than by a fixed count
    // keeps three short names when they fit and two long ones when they do
    // not, instead of running off the edge either way.
    const parts = []
    let width = 16 // "pattern " in main.js, plus "auto -- " here
    let dropped = 0
    for (const l of this._byWeight) {
      const piece = `${PATTERNS[l.index].name} ${l.weight.toFixed(2)}`
      // 53 leaves room for the "  +N more" suffix inside the 62.
      if (l.weight < 0.02 || width + piece.length + 2 > 53) dropped++
      else {
        parts.push(piece)
        width += piece.length + 2
      }
    }
    const head = parts.length ? parts.join(', ') : 'nothing you could see'
    return `auto -- ${head}${dropped ? `  +${dropped} more` : ''}`
  }

  get blurb() {
    if (this.pattern >= 0) return PATTERNS[this.pattern].blurb
    return this.live.length ? PATTERNS[this._byWeight[0].index].blurb : ''
  }

  // Read order, not draw order. composeAuto returns the reserved floor form
  // last because that is where its slots are, but the HUD's job is to say what
  // you are looking AT, and that is whichever form is loudest.
  get _byWeight() {
    return [...this.live].sort((a, b) => b.weight - a.weight)
  }

  // `head` is her world position, `state` the clock state, `elapsedReal` real
  // seconds since start.
  //
  // The animation clock is REAL seconds, not in-world hours, and deliberately:
  // the folds should shimmer at the speed a real aurora shimmers regardless of
  // how fast the day is running, and a time skip should not fast-forward the
  // bands through six minutes of writhing in one frame. The COMPOSER is on
  // in-world hours, so a skip does change which forms are up -- which is the
  // whole point of the skip.
  update(head, state, elapsedReal) {
    const i = state.aurora
    this.mesh.visible = i > 0.004
    if (!this.mesh.visible) {
      this.live = []
      return
    }

    this.live =
      this.pattern >= 0
        ? [{ index: this.pattern, weight: 1 }]
        : composeAuto(state.elapsed, state.activity, this.seed)
    this._packBands(bandsFor(this.live))

    this.mesh.position.copy(head)
    const u = this.material.uniforms
    u.uTime.value = elapsedReal
    u.uIntensity.value = i
    u.uActivity.value = state.activity
  }

  _packBands(bands) {
    const { bandA, bandB, bandC, bandD, bandE, bandF, bandG, bandT } = this
    for (let s = 0; s < SLOTS; s++) {
      const b = bands[s]
      const i4 = s * 4
      const i3 = s * 3
      if (!b) {
        // Brightness alone switches a slot off -- the vertex shader tests it
        // first and returns. The rest is left stale on purpose: writing it
        // would be 20 floats of work to no effect.
        bandA[i4 + 3] = 0
        continue
      }
      bandA[i4] = b.dist
      bandA[i4 + 1] = b.az
      bandA[i4 + 2] = b.span
      bandA[i4 + 3] = b.bright
      bandB[i4] = b.alt0
      bandB[i4 + 1] = b.alt1
      bandB[i4 + 2] = b.fold
      bandB[i4 + 3] = b.foldHz
      bandC[i4] = b.speed
      bandC[i4 + 1] = b.drift
      bandC[i4 + 2] = b.ray
      bandC[i4 + 3] = b.rayHz
      bandD[i4] = b.lobes
      bandD[i4 + 1] = b.ragged
      bandD[i4 + 2] = b.flick
      bandD[i4 + 3] = b.fringe
      bandE[i4] = b.pulse
      bandE[i4 + 1] = b.tintAmt
      bandE[i4 + 2] = b.seed
      bandF[i4] = b.pale
      bandF[i4 + 1] = b.crown
      bandF[i4 + 2] = b.shear
      bandF[i4 + 3] = b.breathe
      bandG[i4] = b.twist
      bandG[i4 + 1] = b.flame
      bandG[i4 + 2] = b.curl
      bandT[i3] = b.tint[0]
      bandT[i3 + 1] = b.tint[1]
      bandT[i3 + 2] = b.tint[2]
    }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
