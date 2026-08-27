// ---------------------------------------------------------------------------
// The two shaders. No three.js import here either -- these are strings, and keeping them importable from Node means the gate can parse them.
//
// ===========================================================================
// THE SHAPE OF THE THING
// ===========================================================================
//
// Lawlor and Genetti's 2004 factoring: an aurora is a 2D curve on the ground crossed with a 1D function of altitude. Emission is field-aligned, so nothing about the vertical profile depends on where you are along the curve except through the curve itself. That is not an approximation for cheapness, it is what the physics does -- electrons spiral down field lines, and the field lines are vertical to within a few degrees.
//
// So: the footprint is a curve, evaluated in the VERTEX shader; the vertical profile is an analytic function, evaluated in the FRAGMENT shader. There is no march because there is nothing to march through. The volume integral along a ray is exactly what additive blending computes when the sheets overlap, and the rasteriser does it for free.
//
// ===========================================================================
// WHY THE FOOTPRINT IS A PARAMETRIC CURVE AND NOT A POLAR GRAPH
// ===========================================================================
//
// The obvious way to bend a band is radius as a function of azimuth. It is single-valued in azimuth by construction, so it can flap toward you and away from you and that is the entire vocabulary. Every photograph of a substorm shows the thing a polar graph cannot do: the band doubles back on itself, so one direction of sky holds two crossings of the same curtain, and where it does the two overlaps add and you get the bright hook that is the whole reason people photograph auroras.
//
// Here the curve carries a displacement in BOTH plan directions -- sideways (u_cuWander) and along-track (u_cuCurl), a quarter wavelength out of phase. That is a trochoid. Below a curl of about 1 the along-track speed 1 + dT stays positive and it is a fold; above it the speed goes negative, the parameter runs backwards through the world, and the curtain genuinely lies over itself. The mesh does not care -- it is additive and depth-write is off, so two layers of the same sheet just add, which is also what the real one does.
//
// ===========================================================================
// WHY THE GATE IS GEOMETRY
// ===========================================================================
//
// Roughly a third of the curtains are dark at any moment. Multiplying their fragments by zero costs exactly as much as drawing them, because the fragment ran. So the gate is applied to the COLUMN HEIGHT in the vertex shader: a column whose visibility reaches zero is shrunk to zero height, its two quads become zero-area, and primitive assembly discards them before rasterisation. That saving is real and it is worth 29% of measured overdraw -- but ONLY at u_cuGateAmt 1.0, which is not the shipped default. See the note at the collapse itself.
//
// The alternative is discard in the fragment shader, which is worse twice over: the fragment has already been shaded when you discard it, and a shader containing discard cannot use early-Z on a tiler, so the whole mesh would stop being rejected behind the mountains. There is no discard in this file.
//
// ===========================================================================
// WHY THERE ARE NO LOOPS AND NO TEXTURE FETCHES
// ===========================================================================
//
// Everything is sines. Not because sines are cheap in isolation but because the alternatives are worse on this target: a value-noise lookup is a dependent texture fetch or eight fetches plus interpolation, and an integer hash needs GLSL ES 3.00 constructs this material does not have. Three sines at incommensurate ratios (1 : 1.618 : 2.414) give something that does not visibly repeat over the distances involved and costs one instruction each on hardware with a transcendental unit.
// ---------------------------------------------------------------------------

import { curtainParams } from './params.js'

const GLSL_TYPE = { float: 'float', color: 'vec3' }

// Declarations are generated from the schema, so a param that no GLSL line reads is impossible to create by accident and a GLSL line reading a param that does not exist is a compile error rather than a slider that does nothing. Same discipline screen.js uses, same reason.
function declarations() {
  const lines = []
  for ( const p of curtainParams() ) {
    if ( !p.uniform ) continue
    const type = GLSL_TYPE[ p.type ]
    if ( !type ) throw new Error( 'aurora-curtains: no GLSL type for param type "' + p.type + '" on "' + p.key + '"' )
    lines.push( 'uniform ' + type + ' u_' + p.key + ';' )
  }
  // Not schema params: the clock, and the world units per kilometre that turns the whole thing from a physical description into scene coordinates.
  lines.push( 'uniform float u_cuTime;' )
  lines.push( 'uniform float u_cuKm;' )
  lines.push( 'uniform vec3 u_cuOrigin;' )
  return lines.join( '\n' )
}

const COMMON = `
precision highp float;

#define CU_TAU 6.28318530718

// Three sines at ratios 1 : 1.618 : 2.414. The second is the golden ratio and the third is the silver one, so no two of them share a period and the sum has no repeat you can find by looking. Returns 0..1 with its mass between about 0.25 and 0.75, which is why the thresholds that read it sit near the middle of their range rather than near zero.
// The second argument is time, and it enters as a PHASE SHIFT on the higher harmonics rather than as an offset on the coordinate. That is the difference between a pattern that morphs where it stands and one that slides across the sky, and sliding is the tell that gives away every procedural aurora.
float cuWob( float a, float b ) {
  vec3 s = sin( vec3( a, a * 1.618 + b, a * 2.414 - b * 1.3 ) + vec3( 0.0, 1.7, 4.2 ) );
  return ( s.x + s.y + s.z ) * 0.16666667 + 0.5;
}
`

export const CURTAIN_VERTEX = `${ COMMON }
${ declarations() }

attribute float aU;
attribute float aV;
attribute float aCurtain;
attribute float aLeaf;

varying vec3 vWPos;
varying vec3 vNrm;
varying vec4 vInfo;

void main() {

  float t = u_cuTime;
  float fi = aCurtain;

  // Per-curtain constants. fract of the index times the golden ratio is the cheapest sequence that fills 0..1 evenly for every prefix -- unlike a hash it has no clusters at small counts, which matters because there are only eighteen of these and a hash would happily give three of them nearly the same value.
  float f01 = fi / max( u_cuCurtains - 1.0, 1.0 );
  float j = fract( fi * 0.6180339 + u_cuSeed * 0.07 );
  float ph = fi * 2.3999632 + u_cuSeed * 1.7;
  float sgn = mod( fi, 2.0 ) < 0.5 ? 1.0 : -1.0;

  // Distance from the eye, biased toward the near end. The near curtains subtend the most sky, so they are where extra members are worth their fill rate; even spacing spends half the family on the compressed strip above the horizon.
  float dist = mix( u_cuNear, u_cuFar, pow( f01, max( u_cuStack, 0.05 ) ) );

  // Sample by ANGLE, not by distance. Uniform kilometres along a curtain 230 km away puts a vertex every 13 degrees at the middle of the sky and every fraction of a degree at the ends, which is exactly backwards: the middle is where you are looking. Equal angular spacing costs one tan() and makes the segment budget mean the same thing everywhere.
  float ang = ( aU - 0.5 ) * 2.0 * radians( u_cuSpan );
  float x0 = dist * tan( ang );

  // Column height varies along the curtain, so the top of the sky is not a straight line. A rectangle of aurora is the single most artificial thing this could do, and it is the thing the old polygon version did.
  float rag = cuWob( x0 / max( u_cuRaggedKm, 1.0 ) + ph * 3.1, t * 0.03 );
  float band = max( u_cuAltHigh - u_cuAltLow, 1.0 );
  float colH = band * mix( 1.0, 0.30 + 0.70 * rag, u_cuRagged );

  // Visibility, decided here rather than in the fragment shader so it can be spent on geometry.
  float gsig = cuWob( fi * 3.77 + u_cuSeed * 2.3, t * u_cuGateRate * CU_TAU );
  float gate = mix( 1.0, smoothstep( u_cuGate, u_cuGate + 0.20, gsig ), u_cuGateAmt );
  float psig = cuWob( x0 / max( u_cuPatchKm, 1.0 ) + ph, t * u_cuPatchRate * CU_TAU );
  // Named burn and not patch, because patch is a RESERVED WORD in the ESSL grammar ANGLE enforces (it is a tessellation keyword), and ANGLE rejects it in every shader version. ANGLE is the GL layer under Chrome, Edge, Safari and the Quest browser, so this did not fail on one machine -- it failed everywhere WebGL runs, and the whole material silently never linked.
  float burn = mix( 1.0, smoothstep( 0.18, 0.72, psig ), u_cuPatchAmt );

  // The ends. A curtain that stops has a silhouette, and a silhouette is a polygon caught in the act. Both smoothsteps run in the same direction, because a reversed-edge smoothstep is undefined behaviour in the ES spec and returns whatever the driver felt like.
  float ends = smoothstep( 0.0, 0.24, aU ) * ( 1.0 - smoothstep( 0.76, 1.0, aU ) );
  float vis = gate * burn * ends;

  // The intended saving: a column below the cull threshold gets zero height, so both of its quads are zero-area and never reach a fragment.
  //
  // MEASURED, and it is weaker than it reads. smoothstep returns exactly zero only when its argument is at or below edge0, and edge0 here is 0.0 -- so a column collapses only when vis reaches EXACTLY zero, not merely when it drops below u_cuCull. vis is gate * burn * ends, and gate floors at 1 - u_cuGateAmt while burn floors at 1 - u_cuPatchAmt, so at the shipped 0.72 and 0.55 the interior floor is 0.126 and no interior column ever collapses at any setting of this knob. Measured overdraw across the whole slider: 5.43 to 5.31, which is 2%. At u_cuGateAmt 1.0 the gate does reach zero and the mean drops to 3.85, a real 29%.
  //
  // Left as it is rather than quietly retuned, because the choice is a look decision and not a bug: a gate that reaches zero deletes a third of the curtains outright instead of leaving them at 28% brightness, and which of those is the better sky is not something the arithmetic can say.
  float hgt = colH * smoothstep( 0.0, max( u_cuCull, 1e-4 ), vis );
  float alt = u_cuAltLow + hgt * aV;

  // The lean. Field lines are 78 degrees from horizontal at auroral latitudes, so a column is not vertical -- its top is displaced along the band from its foot. Evaluating the curve at the SHEARED coordinate is what makes the whole column lean together, and holding the striation coordinate at x0 further down is what keeps the rays field-aligned while it does.
  float xe = x0 + u_cuLean * ( alt - u_cuAltLow );
  float hf = aV;

  // Folds open out with altitude because the field lines they follow converge downward. Without this a curtain is a wall.
  float splay = 1.0 + u_cuSplay * hf;

  // The one curve the whole family follows. Two harmonics at 1.73, which is close enough to irrational that the pair does not close on itself over the few wavelengths ever visible at once.
  float mk = CU_TAU / max( u_cuMeanderKm, 1.0 );
  float ms = ( xe + u_cuDrift * t * u_cuMeanderKm ) * mk;
  float M = ( sin( ms ) + 0.5 * sin( ms * 1.73 + 1.3 ) ) * u_cuMeander;
  float dM = ( cos( ms ) + 0.865 * cos( ms * 1.73 + 1.3 ) ) * u_cuMeander * mk;

  // Shear: the far members swing further on the shared curve than the near ones. This is the entire defence against wallpaper. With it the gaps between curtains breathe -- they crowd here and splay there and the pattern never returns -- and without it the family is one curve rigidly translated and every gap is the same gap forever.
  float shear = 1.0 + u_cuShear * ( f01 * 2.0 - 1.0 );

  // Each curtain's own departure from the family curve, at its own amplitude, its own phase and its own DIRECTION of travel. The alternating sign is what makes neighbours slide past one another and pinch, rather than marching in step.
  float wk = CU_TAU / max( u_cuWanderKm, 1.0 );
  float wamp = u_cuWander * ( 0.55 + 0.9 * j ) * splay;
  float w1 = xe * wk + ph + sgn * u_cuWanderDrift * t * ( 0.7 + 0.6 * j );
  float W = sin( w1 ) * wamp;
  float dW = cos( w1 ) * wamp * wk;

  // The along-track partner, a quarter wavelength out of phase, which turns the sideways wiggle into a rolled loop. Past a curl of about 1 the along-track speed 1 + dT goes negative and the curtain lies over itself.
  float T = cos( w1 ) * wamp * u_cuCurl;
  float dT = -sin( w1 ) * wamp * wk * u_cuCurl;

  float px = xe + T;
  float py = dist + M * shear + W;

  // The tangent is the exact derivative, not a finite difference. Differencing would mean evaluating the whole curve a second time at x0 + epsilon, which is every sine above run twice, to get a worse answer.
  vec2 tang = normalize( vec2( 1.0 + dT, dM * shear + dW ) );
  vec2 nrm = vec2( -tang.y, tang.x );

  // Leaves: parallel sheets a few kilometres apart along the surface normal, so a curtain has thickness that the blend integrates rather than a single infinitely thin sheet. Centred on the curve so raising the leaf count thickens the curtain instead of moving it.
  float off = ( aLeaf - ( u_cuLeaves - 1.0 ) * 0.5 ) * u_cuThickKm;
  px += nrm.x * off;
  py += nrm.y * off;

  // Plan Y is northward, which is world -Z. The origin follows the eye on the horizontal only, so a walking player never comes out from under the thing -- at 230 km the parallax from twenty metres of walking is nine millionths of a degree, so there is nothing real being thrown away here. Altitude is absolute, because the eye going up a mountain genuinely should change the elevation angle of the hem.
  vec3 wp = vec3( px * u_cuKm + u_cuOrigin.x, alt * u_cuKm, -py * u_cuKm + u_cuOrigin.z );

  vNrm = normalize( vec3( nrm.x, 0.0, -nrm.y ) );
  vWPos = wp;

  // hemSoft varies per curtain, so the lower borders are not all equally sharp. One global softness gives every curtain the same edge, and a sky of identical edges reads as one material cut into strips.
  vInfo = vec4( hf, x0, vis, u_cuHemSoft * mix( 0.45, 1.75, j ) );

  // viewMatrix rather than modelViewMatrix: every position above is already in world space, so the mesh's own transform is deliberately ignored. Moving the mesh would do nothing, which is correct -- this thing is 400 km across and is not a prop you place.
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}
`

export const CURTAIN_FRAGMENT = `${ COMMON }
${ declarations() }

varying vec3 vWPos;
varying vec3 vNrm;
varying vec4 vInfo;

void main() {

  float t = u_cuTime;
  float h = vInfo.x;
  float along = vInfo.y;
  float vis = vInfo.z;
  float hemSoft = vInfo.w;

  // The deposition profile. Sharp lower border from the smoothstep, exponential thinning upward standing in for the electron energy spectrum, and a forced dissolve to exactly zero before the top row of the mesh. That last term is not cosmetic: a profile still non-zero at h = 1 draws the topmost row of triangles, and a row of triangles across the sky is a straight line. It is written as 1 - smoothstep(lo, hi, h) and never as smoothstep(hi, lo, h), because a smoothstep with its edges reversed is undefined in the ES spec.
  float dep = smoothstep( 0.0, max( hemSoft, 1e-3 ), h ) * exp( -h * u_cuFalloff ) * ( 1.0 - smoothstep( u_cuTopFade, 1.0, h ) );

  // View direction, and the one lighting term an optically thin emitter has. Looking along a sheet you see through far more glowing gas than looking square at it, so brightness goes as one over the cosine of the angle between the view and the surface. abs() because a glow has no front and no back. The clamp is not taste -- an exactly edge-on polygon is a division by zero and a line of fireflies across the sky.
  vec3 view = normalize( vWPos - cameraPosition );
  float ec = abs( dot( view, normalize( vNrm ) ) );
  float graze = mix( 1.0, clamp( 1.0 / max( ec, 1.0 / u_cuGrazeMax ), 1.0, u_cuGrazeMax ), u_cuGraze );

  // Edge-on, the line of sight crosses a great deal of gas and the fine structure genuinely averages out. Physically true and conveniently also the fix for the aliasing, since the most foreshortened parts of the sky are where a 4 km striation lands inside a pixel.
  float sharp = mix( 1.0, smoothstep( 0.0, 0.45, ec ), u_cuBlur );

  // The rays. No height term anywhere in this, which is the whole point: every striation runs dead vertically from hem to crown because electrons follow field lines and field lines are vertical. Ridged rather than smooth, because what the eye actually picks out of a rayed band is the dark creases between the rays, not the rays.
  float r1 = cuWob( along / max( u_cuRayKm, 0.05 ), 0.0 );
  float ridge = 1.0 - abs( 2.0 * r1 - 1.0 );
  float clump = cuWob( along / max( u_cuClumpKm, 0.5 ) + 11.3, t * 0.05 );
  float rays = mix( 1.0, mix( 0.32, 1.05, ridge ) * mix( 0.55, 1.30, clump ), u_cuRays * sharp );

  // Two wave systems at 1 and 1.37, travelling in opposite directions. Where they momentarily agree a thin bright filament appears, and because the ratio is close to irrational the agreement never lands in the same place twice. This is how caustics on a pool floor are built, and it is why the result reads as shimmer rather than as a texture being dragged along.
  float p = along / max( u_cuShimKm, 0.1 );
  float s1 = sin( p * CU_TAU + t * u_cuShimSpeed * CU_TAU );
  float s2 = sin( p * CU_TAU * 1.37 - t * u_cuShimSpeed * CU_TAU * 0.83 + 2.1 );
  float caust = pow( clamp( abs( 0.5 * ( s1 + s2 ) ), 0.0, 1.0 ), u_cuShimPow );
  float shimmer = 1.0 + u_cuShimmer * caust * 2.2 * sharp;

  // Hem streaks. The lower border is the part of an aurora the eye tracks, so it earns its own term: short vertical fingers that brighten and fade independently of the curtain above them, confined to the bottom third of the column.
  float hemMask = 1.0 - smoothstep( 0.0, 0.32, h );
  float fr = cuWob( along / max( u_cuFringeKm, 0.5 ) + 41.7, t * 0.13 );
  dep *= mix( 1.0, mix( 0.10, 1.45, fr ), u_cuFringe * hemMask );

  // Air between here and a curtain 780 km away, most of it low down. Without this the far members end at exactly the horizon cut and lay a hard bright line along the tops of the mountains.
  float ext = mix( 1.0, smoothstep( u_cuHorizon, u_cuHorizon + 0.16, view.y ), u_cuExtinct );

  // Altitude colour. These are emission lines, not a palette: 427.8 nm N2+ at the hem, 557.7 nm atomic oxygen through the body, 630.0 nm oxygen in the crown. u_cuPale is how hard the precipitation is -- energetic electrons excite the nitrogen bands alongside the atomic lines and whiten both ends.
  vec3 violet = mix( vec3( 0.62, 0.18, 0.72 ), vec3( 0.18, 0.60, 1.00 ), u_cuPale );
  vec3 green = mix( vec3( 0.14, 1.00, 0.44 ), vec3( 0.56, 1.00, 0.84 ), u_cuPale );
  vec3 c = mix( violet, green, smoothstep( 0.0, max( u_cuHemBand, 1e-3 ), h ) );

  // The crown is added rather than replacing, and clamped below 1, because the red and the green are emitted along the same line of sight and what reaches the eye is a sum. Replacing would give a red band with a hard bottom edge, which is a thing no sky does.
  c = mix( c, vec3( 1.00, 0.20, 0.46 ), clamp( smoothstep( u_cuCrownStart, 1.0, h ) * u_cuCrown, 0.0, 0.95 ) );

  // The lie, on a dial. A cosine palette travelling ALONG the curtain -- the only place in this shader where time is a translation, which is deliberate, because it is the one term that should read as something moving through the aurora rather than as the aurora changing shape.
  float x = along / max( u_cuFlowKm, 1.0 ) + t * u_cuFlowSpeed * 0.1;
  vec3 phase = vec3( 0.0, 0.3333, 0.6667 ) * u_cuNeonSpread;
  vec3 neon = 0.5 + 0.5 * cos( CU_TAU * ( phase + x + u_cuNeonShift ) );
  c = mix( c, neon, u_cuNeon );

  c = mix( c, u_cuTint, u_cuTintAmt );

  // Saturation around Rec. 709 luma rather than around the channel mean, so pushing it does not also change how bright the sky reads.
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, u_cuSaturate );

  // Divided by the leaf count so turning thickness up changes the softness of the curtain and not its brightness, which is what makes an A/B between one leaf and three worth anything.
  float e = dep * vis * rays * graze * shimmer * ext * u_cuGain * u_cuExposure / max( u_cuLeaves, 1.0 );

  // No discard anywhere in this shader. A shader containing discard cannot be early-Z rejected on a tiler, and this mesh spends most of its fragments behind mountains.
  gl_FragColor = vec4( max( c, 0.0 ) * max( e, 0.0 ), 1.0 );
}
`

// The reverse check. Generated declarations catch a GLSL line reading a param that does not exist; this catches a param that exists and no GLSL line reads, which is the silent one -- a slider that moves and does nothing.
export function auditUniformUse() {
  const body = CURTAIN_VERTEX + CURTAIN_FRAGMENT
  const unused = []
  for ( const p of curtainParams() ) {
    if ( !p.uniform ) continue
    const name = 'u_' + p.key
    // Count uses beyond the two generated declarations, one per stage.
    let n = 0
    let i = body.indexOf( name )
    while ( i !== -1 ) {
      const after = body.charCodeAt( i + name.length )
      const isWord = ( after >= 48 && after <= 57 ) || ( after >= 65 && after <= 90 ) || ( after >= 97 && after <= 122 ) || after === 95
      if ( !isWord ) n++
      i = body.indexOf( name, i + 1 )
    }
    if ( n <= 2 ) unused.push( p.key )
  }
  if ( unused.length ) throw new Error( 'aurora-curtains: these params declare uniforms no GLSL line reads: ' + unused.join( ', ' ) )
  return true
}
