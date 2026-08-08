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
// Everything is built in KILOMETRES and scaled by KM on the way out, because
// the physics is quoted in kilometres and a file full of 4050.0 would be
// unreadable. At 45 units/km the camera's 20000-unit far plane sits at 444 km,
// which is what caps band altitude in aurora-patterns.js.
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
// occludes it, and the geometry is far enough out and high enough up that this
// only happens where it should.
// ---------------------------------------------------------------------------

const KM = 45 // world units per kilometre

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

// The meander amplitude, as a fraction of a band's distance from the viewer.
// One number for the whole sky rather than a per-form one, because what it sets
// is how many DEGREES OF SKY the hem rises and falls, and that reads the same
// whichever form is up. At 0.36 the catalogue measures 2.2 degrees of hem swing
// on the quietest arc and 8.3 on a breakup -- check-daynight.mjs walks the
// footprint and prints the whole table. Per-form variation is the `meander`
// field in aurora-patterns.js, which multiplies this; it exists only so the two
// forms that are straight in nature can be held straight.
const MEANDER_FRAC = 0.36

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
// the band, putting it in the second axis makes the pattern MORPH IN PLACE.
// Real folds do the latter.
// ===========================================================================
// TWO COMPONENTS, AND WHY THE HEM USED TO BE A STRAIGHT LINE
// ===========================================================================
//
// This used to return one number, and the vertex shader wrote
//
//     p = dir * ( dist + fold ) + up * alt
//
// which is a POLAR GRAPH: radius as a function of azimuth. A polar graph is
// single-valued in its angle by construction, so no amount of amplitude can
// make the footprint double back. It wanders toward and away from the viewer,
// which perspective turns into a hem that rises and falls a little, but two
// parts of the band can never sit at the same bearing -- so the curtain cannot
// weave, cannot overlap itself, and its hem cannot trace an S. It flaps. That
// was the reported complaint and it was a property of this one line, not of the
// shader or the hardware.
//
// A TANGENTIAL component makes the footprint a general parametric curve in the
// ground plane, and a general curve may turn back. Walking the band, the
// along-track speed is 1 + d(tangential)/d(km); where that goes negative the
// track reverses and the same stretch of sky gets two layers of curtain, which
// is the shape in every photograph of a folded arc.
//
// The tangential octaves are the SAME noise sampled a quarter wavelength along.
// A quarter-wave offset between two components traces a circle, so each octave
// contributes a loop rolled along the band -- the trochoid family, which is
// what an auroral curl physically is. Independent noise in the second axis
// gives a curve that wanders in two axes without ever closing, which reads as
// jitter rather than as weaving.
//
// THE MEANDER is the other half, and it is the one doing the S. Every octave
// this function had was shorter than the band and scaled by the band's fold
// amplitude, so the hem could only ever be a wiggly line: the wiggles were
// small compared to the arc and they got smaller the quieter the form was. The
// meander is a separate wave -- roughly a third of the visible span of a band,
// so about two swings across the sky -- and its amplitude is a fraction of the
// band's DISTANCE rather than a multiple of its folds. That is what makes a
// quiet arc serpentine as much as a breakup does, which is right: the folds
// belong to the curtain, the meander is the path the curtain is hanging along.
// It is measured in mkm, kilometres normalised to the 250 km reference, so the
// swing is the same number of degrees of sky however far out the band sits.
const FOLD_GLSL = `
  vec2 aurFold( float km, float t, float amp, float hz, float act, float curl, float ms, float mAmp ) {
    // ---- The curtain's own pleating. Three octaves at rates that are not
    // integer multiples of each other, all of them scaled by the band's fold
    // amplitude, all of them SHORTER than the band.
    vec2 f = vec2( aurNoise( vec2( km * 0.0125 * hz,                 t * 0.055 ) ),
                   aurNoise( vec2( ( km + 20.0 / hz ) * 0.0125 * hz, t * 0.055 ) ) ) - 0.5;
    f += ( vec2( aurNoise( vec2( km * 0.0410 * hz,                 t * 0.130 ) ),
                 aurNoise( vec2( ( km + 6.1 / hz ) * 0.0410 * hz,  t * 0.130 ) ) ) - 0.5 ) * 0.52;
    // The last octave is gated on activity. A quiet aurora is a smooth arc; the
    // fine curls only appear at breakup. That progression -- arc, then folds,
    // then curls -- is the Akasofu substorm sequence, and animating it is most
    // of why standing and watching this is worth doing.
    f += ( vec2( aurNoise( vec2( km * 0.1350 * hz,                 t * 0.310 ) ),
                 aurNoise( vec2( ( km + 1.85 / hz ) * 0.1350 * hz, t * 0.310 ) ) ) - 0.5 )
         * 0.34 * act;
    f *= amp;

    // ---- The meander: where this segment of the oval actually runs. Added
    // AFTER the amp multiply, because its amplitude comes from the band's
    // distance and not from its fold amplitude -- see the meander field in
    // aurora-patterns.js for why those are different things. It is the longest
    // wave here by a wide margin: about a third of the visible span of a band,
    // measured in mkm so the swing is the same number of degrees of sky at 86
    // km as at 295 km.
    float mkm = km * ms;
    float q   = 73.5;       // a quarter wavelength of the meander, in mkm
    f += ( vec2( aurNoise( vec2( mkm * 0.0034,         t * 0.014 ) ),
                 aurNoise( vec2( ( mkm + q ) * 0.0034, t * 0.014 ) ) ) - 0.5 ) * mAmp;

    // curl is the tangential amplitude relative to the radial one, and it is
    // allowed past 1: the radial component is what the fold costs in apparent
    // DEPTH, which the eye reads as very little at 250 km, while the tangential
    // component is free and does all of the visible work. curl 0 is exactly the
    // old single-component behaviour.
    return vec2( f.x, f.y * curl );
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
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 150 * KM, 0), 400 * KM)
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
    this.bandE = arr(4) // pulse, tintAmt, seed, curl
    this.bandF = arr(4) // pale, crown, shear, breathe
    this.bandG = arr(4) // meander, and three spare
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
        varying vec3 vCol;   // palette: paleness, crown strength, base softness
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

          // ---- Footprint. A circular arc centred on the viewer, which is what
          // an auroral arc looks like from underneath: the oval is thousands of
          // km across, so the near part of it reads as a band crossing the sky
          // rather than as a ring.
          float a = radians( A.y + ( aU - 0.5 ) * A.z );
          vec3 dir = vec3( sin( a ), 0.0, -cos( a ) );   // north is -z, east is +x
          vec3 tng = vec3( cos( a ), 0.0, sin( a ) );

          // Distance along the footprint from its centre, in km, plus the slow
          // translation. Real arcs drift -- usually westward before midnight --
          // and the drift is applied to the SHAPE coordinate so the whole
          // structure travels together rather than the pattern sliding through
          // a stationary silhouette.
          float km = ( aU - 0.5 ) * radians( A.z ) * A.x + uTime * C.y;

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

          // ---- Presence. The slowest and deepest of the four envelopes, and
          // the one that decides whether a stretch of band is in the sky at
          // all right now.
          //
          // flick above works at ~2 km and a few seconds: individual rays
          // guttering. This works at ~150 km and a couple of minutes: whole
          // SECTIONS of a band. That separation of scales is the point. An
          // aurora is not a light that dims, it is a set of regions that are
          // either lit or not, and the lit regions move.
          //
          // The curve is deliberately not symmetric. Squaring a smoothstep
          // that only starts climbing at 0.20 leaves the typical value near
          // 0.15 and the peak near 2.2 -- so a band spends most of its life
          // faint or invisible, occasionally flares far brighter than a linear
          // envelope would ever allow, and the flare is an event you notice
          // rather than a state it sits in. The additive blend clips those
          // peaks toward white, which is what a real substorm surge does to a
          // camera and to the eye.
          float mac = aurNoise( vec2( km * 0.0062, t * 0.028 ) ) * 0.62
                    + aurNoise( vec2( km * 0.0210, t * 0.070 ) ) * 0.38;
          float presence = mix( 1.0, 0.10 + 2.10 * pow( smoothstep( 0.20, 0.90, mac ), 2.0 ), F.w );

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
          float endTaper = smoothstep( 0.0, 0.30, aU ) * smoothstep( 1.0, 0.70, aU );
          float ovality = mix( 0.40, 1.0,
                               smoothstep( 0.0, 0.44, aU ) * smoothstep( 1.0, 0.56, aU ) );
          topKm = baseKm + ( topKm - baseKm ) * ovality;

          // ================================================================
          // Position
          // ================================================================
          float alt = mix( baseKm, topKm, aV );

          // Fold amplitude grows with altitude. Field lines converge downward,
          // so a fold is tighter at the bottom edge and splays out above -- it
          // is why curtains look like curtains and not like walls.
          //
          // The floor is 0.86 rather than 0.55, and that is the other half of
          // "the bottom hem traces S shapes". At 0.55 the BASE of a band barely
          // folded at all, so however much the top writhed the hem stayed a
          // level line -- and the hem is the part of an aurora the eye tracks.
          // The splay is still here, it just no longer starts from nothing.
          float amp = B.z * ( 0.86 + ( alt - 90.0 ) * 0.0042 );

          // Field lines are not vertical. At 65 N the magnetic dip is about 78
          // degrees, so the top of a 150 km column sits some 30 km along-band
          // from its own base -- and since the fold pattern is carried BY the
          // field lines, the fold at the top is the fold from further along.
          // That is the lean you see in every photograph of a tall rayed band,
          // and cranked up it is also the whole of the auroral spiral form:
          // shear past a full fold wavelength and the column stops reading as
          // a curtain and starts reading as smoke twisting upward.
          float shear = F.z * ( alt - baseKm );
          // "mkm": kilometres normalised to the 250 km reference distance, so
          // the meander is judged in degrees of sky rather than in kilometres
          // and a 295 km arc snakes as widely across its span as an 86 km one.
          // Declared ONCE. A second declaration of this in the same scope is a
          // GLSL redefinition error, which means the shader does not compile,
          // which means there is no aurora at all -- that shipped once, and
          // check-daynight.mjs now scans for it.
          float mScale = 250.0 / A.x;
          vec2 f0 = aurFold( km + shear, t, amp, B.w, uActivity, E.w, mScale, G.x );

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
          vec2 f1 = aurFold( km + shear + dk, t, amp, B.w, uActivity, E.w, mScale, G.x );
          vec3 tanW = normalize( tng * ( dk + f1.y - f0.y ) + dir * ( f1.x - f0.x ) );
          // The sheet is vertical, so its normal is the plan tangent turned 90
          // degrees about up.
          vNrm = normalize( vec3( -tanW.z, 0.0, tanW.x ) );

          vShape = vec4( alt, km, topKm, baseKm );
          vMod = vec4( endTaper * lobe * flick * pulse * presence * breath, fringe, C.z, C.w );
          vCol = vec3( F.x, F.y, soft );

          // The footprint as a general parametric curve rather than as a polar
          // graph -- the tng term is what lets it turn back on itself.
          vec3 p = ( dir * ( A.x + f0.x ) + tng * f0.y + vec3( 0.0, alt, 0.0 ) ) * ${KM.toFixed(1)};
          vec4 world = modelMatrix * vec4( p, 1.0 );
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
        varying vec3 vCol;
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
          float ext = smoothstep( -0.03, 0.14, view.y );

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
      bandE[i4 + 3] = b.curl
      bandF[i4] = b.pale
      bandF[i4 + 1] = b.crown
      bandF[i4 + 2] = b.shear
      bandF[i4 + 3] = b.breathe
      bandG[i4] = b.meander * MEANDER_FRAC * b.dist
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
