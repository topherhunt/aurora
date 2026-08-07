import * as THREE from 'three'
import { WORLD_HALF } from './sim/terrain-height.js'
import { SKY_GLSL } from './sky-glsl.js'
import { SAMPLE_GLSL } from './lighting.js'
import { PROBE } from './sky-probe.js'

/**
 * Lake surfaces (§11), built from Phase A's lake mask.
 *
 * WHY A MASK AND NOT A PLANE PER BODY. A lake is not a disc. Filling a basin to
 * its outlet level gives a shape with arms up every tributary, and a bounding
 * box or a radius around the centroid would put water over dry ground in every
 * concave corner. The mask is the shape, so the mask is what gets drawn.
 *
 * WHY THE SHORELINE IS NOT BLOCKY. The sim grid is 8 m and a stair-stepped
 * 8 m shoreline would be obvious from the ground. So the mask is DILATED by a
 * cell before meshing, which pushes the polygon edge under the terrain rather
 * than leaving it hanging in the air. What you see as the shoreline is then the
 * line where the full-resolution terrain mesh crosses the water plane -- free,
 * exact, and as detailed as the LOD happens to be. The grid never appears.
 *
 * WHAT THE SURFACE ACTUALLY IS: a mirror, not a blue plane.
 *
 * It is opaque, and only slightly blue. Almost everything you see in it is the
 * sky, coming back a little dimmer and bluer than it went in, reflected about a
 * normal that four drifting layers of gradient noise keep bending. The
 * reflection is not a cubemap and not a second render pass -- sky-glsl.js
 * computes the sky's colour from a direction, so the water calls the same
 * function along the reflected ray and gets an answer that is correct at every
 * time of day for free, sunset included, with nothing to keep in step.
 *
 * The mountains come from the horizon map (§8), which already stores, for every
 * point and 16 compass directions, how high the ground rises. Asking it along
 * the reflected ray instead of along the sun's says whether that ray escapes to
 * sky or hits a ridge -- so the reflection cannot see through a mountain, and it
 * costs two texture reads the terrain was already paying for.
 *
 * NOT reflected: the aurora and the stars. Both are separate additive meshes
 * rather than functions of direction, so there is nothing to call. The aurora is
 * the one that will be missed and it is not cheap to fix -- see §11.
 *
 * THERE ARE NO RIVERS, AND THAT IS A MEASURED DECISION.
 *
 * Ribbons along Phase A's flow network were built, checked and rejected. Flow
 * is routed on the CARVED surface, which has ~12,000 breach channels cut
 * through ridges so the world drains; the mesh is built from raw heightAt,
 * where none of those cuts exist. Measured on seed 20260804 at 1024^2:
 *
 *   - 47.4% of river segments run UPHILL on the rendered surface (0.26% on the
 *     carved one). 409 of 457 chains climb somewhere; the worst gains 925 m.
 *   - The uphill rate is 45-50% in EVERY size band, so there is no subset of
 *     well-behaved trunk rivers to keep. Big ones are as wrong as headwaters.
 *   - Tracing by steepest descent on the rendered surface instead -- downhill
 *     by construction -- gives a median run of 39 m before it pits out. Of
 *     21,014 traces, 8 exceed 300 m and 1.7% reach a lake.
 *
 * The third number is the real one: this terrain does not drain. Rivers are not
 * a rendering problem, and no amount of splining, carving-per-chunk or width
 * tuning fixes a network whose valleys are simulation artifacts. They become
 * possible when the GENERATOR produces a draining surface -- fluvial erosion at
 * generation time -- and not before. Lakes are unaffected: they are chosen and
 * verified against the raw surface, so they sit in basins that really exist.
 *
 * This all works only because Phase A's `base` is sampled from the same heightAt
 * the chunk mesher uses, so a level computed on the sim grid is the same level
 * on the rendered ground. If the carved surface (breach channels) ever reaches
 * the mesher, the two agree by construction; until then the lakes are right and
 * only their outlet channels are missing.
 */

// One mesh per tile of the sim grid, so the frustum can reject most of the
// world's water instead of drawing every lake every frame.
const TILE = 64

export const WATER = {
  // The body colour, and it is deliberately a MINORITY of what you see. Real
  // water at any distance is almost entirely a mirror; the blue is what leaks
  // through at steep angles where the Fresnel term is weakest. A lake painted
  // its own colour and lit like a diffuse surface is the single most common
  // reason game water reads as a sheet of blue plastic.
  tint: 0x18303f,
  // Fraction of the surface colour that is reflected sky when looking straight
  // DOWN into it. At grazing angles this goes to 1 on its own (Fresnel), so
  // this number alone decides how blue the lake at your feet is.
  mirrorDown: 0.72,

  // Wave slopes, not heights. The surface geometry stays a flat plane -- only
  // the normal moves -- so amplitude never appears; what the eye reads is the
  // slope, and the slope is what bends the reflection.
  chop: 1.0,

  // Global multiplier on every layer's drift speed, so the whole surface can be
  // calmed or whipped up from one place without disturbing the ratios between
  // the layers. The per-layer speeds below are already the fast ones.
  flow: 1.0,

  // How hard the swell drags the ripples sideways, in ripple-wavelengths. This
  // is the knob that decides whether the surface reads as several independent
  // patterns laid on top of each other, or as one chaotic field. Zero looks
  // like a stack of transparencies; past about 1.0 the ripples smear into
  // streaks. See the domain-warp note in WAVE_GLSL.
  warp: 0.6,

  // Where the fine ripples fade out, in metres. Past this the normal relaxes
  // toward flat and the specular lobe broadens to compensate, which is the
  // aggregate of all the ripples inside one pixel rather than a random sample
  // of one of them. Without it, distant water is a field of crawling white
  // pixels -- the classic specular-aliasing failure, and it is worse in a
  // headset than on a monitor because the head never stops moving.
  detailFrom: 45,
  detailTo: 380,

  // Brightness of the sun and moon highlights, and they are deliberately past
  // 1.0: the glint is thresholded (see below), so the core clips to white and
  // only the rim keeps its tint. The moon's is higher because a moonlit lake is
  // mostly this -- the moon is 400,000 times dimmer than the sun, but the
  // glitter path is the brightest thing in a night scene.
  sunGlitter: 3.0,
  moonGlitter: 5.0,

  // Where the glint switches on, and how sharply. Sun glitter is not a smooth
  // falloff: a facet either points at the light or it does not, so what the eye
  // gets is crisp specks of blown-out white in dark water. `glintEdge` is the
  // lobe value the speck starts at; `glintWidth` is how wide the transition is,
  // and the whole point is that it is narrow.
  glintEdge: 0.45,
  glintWidth: 0.06,

  // Where a mountain blocks the sky. The colour is the mountain's own deep
  // blue rather than a dimmed copy of the sky, because a dimmed copy of a grey
  // dawn is a grey mountain, and the thing that reads as "solid land against
  // sky" is a shift in HUE as much as in brightness.
  //
  // Its brightness still rides the sky's horizon luminance -- `silhouette` is
  // the floor it never drops below, `silhouetteGain` how fast it follows the
  // sky up -- because a silhouette that is black at noon looks like a hole cut
  // in the lake, and one that is slate grey at midnight glows.
  silhouetteTint: 0x14243f,
  silhouette: 0.015,
  silhouetteGain: 0.8,

  // What the reflection loses on the way back out. Every reflection comes back
  // dimmer and bluer than the thing it reflects: the surface transmits some of
  // what arrives instead of bouncing it, and water swallows red first. Two
  // knobs because they are two decisions -- `reflTint` is the hue shift,
  // `reflDim` how much light is lost -- but they multiply into one uniform.
  reflTint: 0xc2d4ee,
  reflDim: 0.8,
}

// Four layers of gradient noise, drifting.
//
// This started as six summed sine trains, which is the textbook answer and is
// wrong for the same reason it is textbook: a sum of periodic functions is
// periodic. Six sines beat against each other on a lattice whose cell is the
// least common multiple of their wavelengths, and the eye finds that lattice
// almost immediately -- the surface reads as wallpaper sliding past. No amount
// of choosing the headings carefully fixes it, because the problem is not the
// headings, it is that cos() comes back.
//
// So each layer is instead a slab of GRADIENT NOISE, which never repeats, and
// each is given four independent things:
//
//   wavelength  the size of its features, in metres
//   slope       how hard it tilts the surface. A SLOPE, not an amplitude: the
//               plane is never displaced, so height never appears anywhere, and
//               the implied wave height is slope * wavelength if you want it
//               (2.9 m of swell down to 11 cm of ripple). The chain-rule factor
//               of 1/wavelength is folded into this number rather than emitted,
//               which is what keeps the four comparable to each other.
//   rotate      the angle its noise lattice is turned to, so no two layers
//               share an axis and nothing lines up with the quads the mesher
//               emits or with the axes the noise hash is built on
//   offset      where in the infinite field it is sampled from, so two layers
//               of the same size are still different noise
//   heading     the compass direction it drifts, in degrees
//   speed       how fast it drifts, in metres per second
//
// `rotate` and `heading` are deliberately unrelated. A layer's lattice being
// turned 41 degrees says nothing about which way the water is running, and
// tying them would put a hidden correlation back into a field whose whole job
// is to have none.
//
// The speeds are twenty times what the first pass used, which was asked for
// and is worth saying out loud: 27 m/s is not what a 52 m ocean swell does, it
// is roughly what a 52 m patch of river surface does. The look is deliberate;
// WATER.flow scales all four if it turns out to be too much.
export const WAVE_LAYERS = [
  { wavelength: 52.0, slope: 0.055, rotate: 13, offset: [148.2, 402.7], heading: 17, speed: 27.0, detail: false },
  { wavelength: 21.0, slope: 0.05, rotate: 41, offset: [317.4, -88.1], heading: 74, speed: 21.0, detail: false },
  { wavelength: 7.5, slope: 0.052, rotate: 97, offset: [-604.9, 251.3], heading: 131, speed: 12.0, detail: true },
  { wavelength: 2.6, slope: 0.042, rotate: 152, offset: [72.6, 933.8], heading: 168, speed: 7.0, detail: true },
]

// Unrolled at build time rather than looped, so the constants are visible in
// the compiled shader instead of living in a uniform array that has to be
// uploaded and kept in step -- and so the two detail layers can sit inside a
// distance branch the driver can see through.
const layerTerm = ({ wavelength, slope, rotate, offset, heading, speed }, fadeExpr, warpExpr, setsWarp = false) => {
  const freq = 1 / wavelength
  const th = (rotate * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  // Compass heading: 0 is north, which is -z. Same convention as wlAzimuth.
  const hd = (heading * Math.PI) / 180
  const vx = Math.sin(hd) * speed
  const vz = -Math.cos(hd) * speed
  const f = (v) => v.toFixed(6)
  return `
    {
      vec2 q = ( p - vec2( ${f(vx)}, ${f(vz)} ) * uFlow * uTime ) * ${f(freq)};
      q = mat2( ${f(c)}, ${f(s)}, ${f(-s)}, ${f(c)} ) * q + vec2( ${f(offset[0])}, ${f(offset[1])} )${warpExpr};
      vec3 n = wNoise( q );
      // Chain rule back out through the rotation: dh/dp is R^T * (dn/dq),
      // times the scale, which is already folded into the slope. Forgetting the
      // TRANSPOSE is the classic way to get a normal field that looks
      // plausible in a still and rotates the wrong way when the light moves.
      g += ( ${f(slope)} * ${fadeExpr} ) * vec2(
        ${f(c)} * n.y + ${f(s)} * n.z,
        ${f(-s)} * n.y + ${f(c)} * n.z );
      ${setsWarp ? 'w = n.yz;' : ''}
    }`
}

const WAVE_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uChop;
  uniform float uFlow;
  uniform float uWarp;

  // A hash over the integer lattice. It must not go periodic at range: this
  // project has already shipped one hash that quietly collapsed at 6 km, and
  // the largest lattice coordinate here is world position over the smallest
  // wavelength, about 3100 for a 2.6 m layer at the edge of an 8 km world.
  // Returns a unit vector, which is what makes the gradient statistics below
  // independent of how good the hash actually is.
  vec2 wHashDir( vec2 c ) {
    vec3 p3 = fract( vec3( c.x, c.y, c.x ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    p3 += dot( p3, p3.yzx + 33.33 );
    float a = fract( ( p3.x + p3.y ) * p3.z ) * 6.28318531;
    return vec2( cos( a ), sin( a ) );
  }

  // Gradient noise, returning ( value, d/dx, d/dy ). The derivative is
  // ANALYTIC rather than a finite difference: a finite difference needs a step
  // size, and any step size is wrong at some distance -- too small and it is
  // noise in the last bits of a float, too large and it flattens the ripples
  // it was meant to measure. The quintic fade and its derivative are the
  // standard pair; du is d/df of u.
  vec3 wNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = p - i;
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );

    vec2 ga = wHashDir( i );
    vec2 gb = wHashDir( i + vec2( 1.0, 0.0 ) );
    vec2 gc = wHashDir( i + vec2( 0.0, 1.0 ) );
    vec2 gd = wHashDir( i + vec2( 1.0, 1.0 ) );

    float va = dot( ga, f );
    float vb = dot( gb, f - vec2( 1.0, 0.0 ) );
    float vc = dot( gc, f - vec2( 0.0, 1.0 ) );
    float vd = dot( gd, f - vec2( 1.0, 1.0 ) );

    float k1 = vb - va;
    float k2 = vc - va;
    float k3 = va - vb - vc + vd;

    return vec3(
      va + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
      ga + u.x * ( gb - ga ) + u.y * ( gc - ga ) + u.x * u.y * ( ga - gb - gc + gd )
         + du * vec2( k1 + k3 * u.y, k2 + k3 * u.x ) );
  }

  // Gradient of the summed height field, which is all that is wanted: the plane
  // is never displaced. 'near' fades the two detail layers; 'far' relaxes
  // everything toward flat at extreme range.
  //
  // DOMAIN WARP: the two detail layers are sampled at a position pushed around
  // by the largest layer's gradient, so the ripples do not merely sit on top of
  // the swell, they are dragged by it -- which is what stops four independent
  // noise fields from reading as four independent noise fields. This is an
  // approximation and worth being honest about: the gradient returned is the
  // gradient of the layers AT the warped position, not the exact gradient of
  // the warped field, which would need the warp's own Jacobian. The exact
  // version costs two more multiplies and looks the same, because the warp is
  // small and slow compared to what it is warping.
  vec3 waveNormal( vec2 p, float near, float far ) {
    vec2 g = vec2( 0.0 );
    vec2 w = vec2( 0.0 );
    ${WAVE_LAYERS.filter((l) => !l.detail).map((l, k) => layerTerm(l, 'far', '', k === 0)).join('')}

    // Branching on distance is coherent -- neighbouring fragments are at
    // neighbouring distances -- so this genuinely skips the two expensive
    // layers over the far half of a lake rather than paying for both sides.
    if ( near > 0.004 ) {
      ${WAVE_LAYERS.filter((l) => l.detail).map((l) => layerTerm(l, 'near', ' + w * uWarp')).join('')}
    }

    return normalize( vec3( -g.x * uChop, 1.0, -g.y * uChop ) );
  }
`

export class Water {
  /**
   * `sky` and `lighting` are shared BY REFERENCE, not copied. The water reflects
   * whatever the sky dome is drawing, using the same function the dome does
   * (see sky-glsl.js), and it asks the horizon map where the mountains are using
   * the same sampler the terrain's shadows do (see lighting.js). Both must
   * therefore be constructed before the water.
   */
  constructor(scene, { sky, lighting, probe }) {
    if (!sky?.uniforms) throw new Error('Water needs the Sky, for the reflection')
    if (!lighting?.uniforms) throw new Error('Water needs WorldLighting, for the horizon map')
    if (!probe?.texture) throw new Error('Water needs the SkyProbe, for the aurora and stars')

    this.scene = scene
    this.group = new THREE.Group()
    this.group.name = 'water'
    scene.add(this.group)

    this.uniforms = {
      ...THREE.UniformsLib.fog,
      ...sky.uniforms,
      // The horizon map only, taken by name rather than by spreading the whole
      // block. WorldLighting also carries uNightLift and uSkyFloor, which lift a
      // Lambert surface out of black after dark -- and a mirror must not be
      // lifted. Its darkness at night is the dark sky it is reflecting, which is
      // the correct answer arrived at for free; adding airglow on top would make
      // the lake glow brighter than the sky above it.
      uHorizonMap: lighting.uniforms.uHorizonMap,
      uSkyView: lighting.uniforms.uSkyView,
      uSunSky: lighting.uniforms.uSunSky,
      uTime: { value: 0 },
      uChop: { value: WATER.chop },
      uFlow: { value: WATER.flow },
      uWarp: { value: WATER.warp },
      uTint: { value: new THREE.Color(WATER.tint) },
      uMirrorDown: { value: WATER.mirrorDown },
      uSilTint: { value: new THREE.Color(WATER.silhouetteTint) },
      uSilhouette: { value: new THREE.Vector2(WATER.silhouette, WATER.silhouetteGain) },
      // Hue shift and light loss are two knobs in WATER because they are two
      // decisions, but nothing downstream needs them apart, so they arrive as
      // one multiply.
      uReflTint: { value: new THREE.Color(WATER.reflTint).multiplyScalar(WATER.reflDim) },
      uDetail: { value: new THREE.Vector2(WATER.detailFrom, WATER.detailTo) },
      uGlitter: { value: new THREE.Vector2(WATER.sunGlitter, WATER.moonGlitter) },
      uGlint: { value: new THREE.Vector2(WATER.glintEdge, WATER.glintWidth) },
      // The aurora and the stars, which are meshes rather than functions of
      // direction and so cannot be answered analytically. See sky-probe.js.
      uProbe: { value: probe.texture },
      uProbeGain: { value: PROBE.gain },
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      // Opaque, and that is a decision rather than a default. Real water this
      // deep is not see-through, and translucency would cost the depth sort, let
      // a submerged boulder show through as a smear, and hand the renderer a
      // back-to-front ordering problem across 90-odd tiles for no gain.
      transparent: false,
      depthWrite: true,
      fog: true,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        #include <fog_pars_vertex>
        void main() {
          vWorldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldPos;
        uniform vec3 uTint;
        uniform float uMirrorDown;
        uniform vec3 uSilTint;
        uniform vec2 uSilhouette;
        uniform vec3 uReflTint;
        uniform vec2 uDetail;
        uniform vec2 uGlitter;
        uniform vec2 uGlint;
        uniform samplerCube uProbe;
        uniform float uProbeGain;
        ${SKY_GLSL}
        ${SAMPLE_GLSL}
        ${WAVE_GLSL}
        #include <fog_pars_fragment>

        // Sun and moon glitter, and it is a THRESHOLD rather than a falloff.
        //
        // pow( d, sharp ) is the statistical answer: the average brightness
        // over all the facets inside one pixel. That is exactly right for water
        // too far away to resolve a single wavelet, and exactly wrong for water
        // at your feet, where a facet either points at the light or it does not
        // and what you actually see is crisp specks of blown-out white sitting
        // in dark water with nothing in between.
        //
        // So how hard the threshold bites rides on 'near': hard up close where
        // a pixel is a fraction of one wavelet, relaxing back to the smooth
        // lobe at range. Doing it the other way round -- thresholding distant
        // water -- turns every pixel into a coin flip as the head moves, which
        // is the specular aliasing the whole distance-fade machinery exists to
        // avoid. Above the threshold the value is 1.0 and the gains are all
        // greater than 1, so the core clips to white and only the rim of each
        // speck keeps the tint of the body that lit it.
        float glint( float d, float sharp, float near ) {
          float lobe = pow( d, sharp );
          return mix( lobe, smoothstep( uGlint.x - uGlint.y, uGlint.x + uGlint.y, lobe ), near );
        }

        void main() {
          vec3 toEye = cameraPosition - vWorldPos;
          float dist = length( toEye );
          vec3 V = -toEye / dist;

          // Two fades, both driven by distance, and they are the same idea
          // applied twice: a pixel covering many wavelengths cannot resolve the
          // individual waves, so the honest answer is the AVERAGE normal (flat)
          // with a WIDER highlight (the lobe those waves would have swept).
          // Fading one without the other gives either a fizzing mess or a dead
          // mirror; doing both is what makes distance read as calm.
          float far = 1.0 - smoothstep( uDetail.y, uDetail.y * 6.0, dist );
          float near = ( 1.0 - smoothstep( uDetail.x, uDetail.y, dist ) ) * far;

          vec3 N = waveNormal( vWorldPos.xz, near, far );
          vec3 R = reflect( V, N );

          // A steep enough facet points the reflection into the ground. Fold it
          // back up rather than clamping: clamping piles every such facet onto
          // the horizon direction at once and draws a bright seam along it.
          // Negating one component of a unit vector leaves it a unit vector.
          if ( R.y < 0.0 ) R.y = -R.y;

          // 0.0: no hard sun or moon disc in the reflection. A 1.1 degree disc
          // sampled through a rippled normal lands on a different answer every
          // pixel -- that is static, not glitter. The broadened highlight below
          // is what replaces it. See sky-glsl.js.
          vec3 refl = skyRadiance( R, 0.0 );

          // ...and it comes back dimmer and bluer than it went in. A mirror
          // that returns exactly what it reflects reads as a hole cut through
          // to a second sky rather than as a surface; this is the term that
          // says there is something there. Physically it is the light the
          // surface transmits instead of bouncing, and water takes red first.
          //
          // Applied to the sky only, not to the glitter added below: the
          // glitter has its own gains, and folding this into them would mean
          // two knobs fighting over one number.
          refl *= uReflTint;

          // The mountains. The horizon map already knows, for every point in the
          // world and 16 compass directions, how high the ground rises -- it was
          // baked for terrain shadows (§8) and this is the same question asked
          // along the reflected ray instead of along the sun's. So the sky
          // reflection cannot look through a ridge, at no cost beyond the two
          // texture reads the terrain was already paying.
          //
          // It is a POINT sample -- the skyline as seen from this patch of water,
          // not from where the ray actually crosses the ridge -- which is right
          // for a mountain kilometres off and approximate for a bank a few metres
          // away. Sixteen azimuths make it a soft, rounded silhouette rather than
          // a crisp ridgeline. Both are the intended lo-fi, not a compromise.
          float blocked = wlBlocked( vWorldPos.xz, R );

          // Declared here, next to what it is derived from, and used twice
          // below -- by the probe and by the glitter. It lived down with the
          // glitter until the probe started using it too, which put a use above
          // its declaration and cost the whole material: GLSL wants declaration
          // first, and a ShaderMaterial that fails to compile does not draw a
          // dimmer lake, it draws nothing at all.
          float lit = 1.0 - blocked;

          // The mountain's own deep blue, brightened by however bright the sky
          // at the horizon is. Not a dimmed copy of the sky: dimming a grey
          // dawn gives a grey mountain, and what reads as land-against-sky is a
          // shift in hue as much as one in brightness. .x is the floor it never
          // falls below, so a moonless midnight is near-black-blue rather than
          // an actual hole; .y is how fast it follows the sky back up, so it is
          // never as bright as the sky beside it.
          float horizonLuma = dot( uHorizon, vec3( 0.2126, 0.7152, 0.0722 ) );
          refl = mix( refl, uSilTint * ( uSilhouette.x + horizonLuma * uSilhouette.y ), blocked );

          // The aurora and the stars, which no function can answer -- both are
          // meshes, so they are captured instead (sky-probe.js) and ADDED here.
          // Added, not mixed, because that is exactly how they are composited
          // into the sky itself: both draw additively over the dome, so the
          // reflected version agrees with the real one by construction rather
          // than by being tuned to match it.
          //
          // After the silhouette and scaled by the lit term, so a ridge hides the
          // aurora's reflection the same way it hides the aurora. Tinted like
          // everything else, because it loses the same light on the way back
          // out of the surface as the sky behind it does.
          refl += texture( uProbe, R ).rgb * ( uProbeGain * lit ) * uReflTint;

          // The glitter path. Broadening the lobe with distance is the other
          // half of the anti-aliasing above; multiplying by (1 - blocked) means
          // a mountain hides the moon's reflection the same way it hides the
          // moon.
          float sharp = mix( 190.0, 2600.0, near * near );
          float sd = max( dot( R, uSunDir ), 0.0 );
          float md = max( dot( R, uMoonDir ), 0.0 );
          refl += vec3( 1.0, 0.94, 0.82 ) * ( glint( sd, sharp, near ) * uGlitter.x * uSunFade * lit );
          refl += vec3( 0.86, 0.91, 1.0 ) * ( glint( md, sharp, near ) * uGlitter.y * uMoon.y * lit );

          // Fresnel. Straight down you see some of the body of the water;
          // edge-on you see nothing but sky. This is the term that makes a flat
          // plane read as a surface rather than as a painted shape, and it is
          // why the far end of a lake is always brighter than the near end.
          float f = pow( 1.0 - clamp( dot( -V, N ), 0.0, 1.0 ), 5.0 );
          float mirror = mix( uMirrorDown, 1.0, f );

          vec3 color = mix( uTint, refl, mirror );

          // FOG, AND THE WATER IS EXEMPT FROM THE NIGHT RULE.
          //
          // Everything else in the world fades toward scene.fog, whose colour
          // is pulled well below the sky's after dark on purpose -- it is what
          // hides the far terrain the moon is not bright enough to light. Water
          // must not obey that. A lake at distance is seen at a grazing angle,
          // where Fresnel is essentially 1, so it is a near-perfect mirror of
          // the sky just above the horizon -- which is why a lake at night
          // reads BRIGHTER than the land around it, not darker. Fading it to
          // the terrain's black is the one thing that unmistakably says
          // "painted surface".
          //
          // So the distance term stays -- air still softens contrast over
          // kilometres -- but it fades toward the sky along the horizontal part
          // of the view ray instead. At full distance a water pixel becomes
          // exactly skyRadiance at the horizon, which is exactly what the dome
          // behind it is drawing, so the two meet with no seam at all. That is
          // a better match than fogColor ever gave, and it costs one more call
          // to a function this shader already has.
          //
          // Done in LINEAR, before the trip to output space, which is the
          // opposite of three's own order -- three fogs afterwards because
          // fogColor is authored in output space. The sky value here is linear,
          // so the mix belongs on this side of the conversion. The dome does
          // the same thing in the same order, which is the whole point.
          #ifdef USE_FOG
            vec2 flatV = V.xz;
            float flatLen = max( length( flatV ), 1e-4 );
            vec3 horizonDir = vec3( flatV.x / flatLen, 0.0, flatV.y / flatLen );
            #ifdef FOG_EXP2
              float fogAmt = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
            #else
              float fogAmt = smoothstep( fogNear, fogFar, vFogDepth );
            #endif
            color = mix( color, skyRadiance( horizonDir, 0.0 ) * uReflTint, fogAmt );
          #endif

          gl_FragColor = vec4( color, 1.0 );

          // tonemapping is a no-op today -- the renderer sets none -- and is
          // here so that turning it on does not leave the water as the one
          // surface in the world that ignored it.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })

    this.lakes = new THREE.Group()
    this.lakes.name = 'lakes'
    this.group.add(this.lakes)
    this.bodies = 0
    this.triangles = 0
  }

  /** Once per frame. `elapsed` is seconds of real time; the waves are the one
   *  thing here that runs on the wall clock rather than on the world clock. */
  update(elapsed) {
    this.uniforms.uTime.value = elapsed
  }

  /**
   * `lake` is Phase A's 0/1 mask, `filled` the flooded surface (so `filled[c]`
   * is that cell's water level -- every cell of one body carries the same
   * value, which is what lets runs be merged without re-labelling bodies).
   *
   * `ground` is THE SURFACE ACTUALLY BEING RENDERED, and it is a separate
   * argument for a reason. Phase A detects lakes on the CARVED surface, which
   * has breach channels cut into it, and priority-flood duly finds puddles at
   * the bottom of those trenches. Measured at 512^2: 392 of 18867 lake cells
   * had the rendered ground standing up to 43 m ABOVE their own water level,
   * because the trench that made them a depression does not exist on the mesh.
   * Water inside solid rock is invisible, so this fails silently -- which is
   * why it is a check rather than a comment.
   *
   * Today the mesher builds from raw heightAt, so callers pass `base`. When the
   * carve delta reaches the chunk workers they should pass `elev` instead and
   * this filter becomes a no-op, which is the correct end state rather than
   * something to remove.
   */
  setFromPhaseA({ lake, filled, ground, n, cell }) {
    this.clear()
    this.n = n
    this.cell = cell

    // Dilate by one cell, carrying the neighbour's level in. Done into a
    // separate level array rather than in place, or the dilation would feed on
    // itself and creep a lake across a whole valley one pass at a time.
    const size = n * n
    const level = new Float32Array(size)
    const wet = new Uint8Array(size)
    const real = new Uint8Array(size)
    this.mask = real
    this.maskLevel = level
    for (let c = 0; c < size; c++) {
      if (!lake[c]) continue
      if (ground[c] >= filled[c]) continue // a puddle in a breach trench; see above
      real[c] = 1
      wet[c] = 1
      level[c] = filled[c]
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i
        if (real[c]) continue
        let best = -Infinity
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di
            const nj = j + dj
            if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
            const d = nj * n + ni
            if (real[d] && filled[d] > best) best = filled[d]
          }
        }
        if (best > -Infinity) {
          wet[c] = 1
          level[c] = best
        }
      }
    }

    // Greedy horizontal runs: consecutive cells at the same level become one
    // quad. Lakes are blobs, so runs are long and this is worth roughly an
    // order of magnitude in triangles over a quad per cell.
    const tiles = new Map()
    for (let j = 0; j < n; j++) {
      let i = 0
      while (i < n) {
        const c = j * n + i
        if (!wet[c]) {
          i++
          continue
        }
        const y = level[c]
        let e = i + 1
        // A run also stops at a tile boundary, so every quad belongs to exactly
        // one tile and tiles stay independently cullable.
        const tileEnd = (Math.floor(i / TILE) + 1) * TILE
        while (e < n && e < tileEnd && wet[j * n + e] && level[j * n + e] === y) e++
        const key = `${Math.floor(i / TILE)},${Math.floor(j / TILE)}`
        let t = tiles.get(key)
        if (!t) {
          t = []
          tiles.set(key, t)
        }
        t.push(i, e, j, y)
        i = e
      }
    }

    const seen = new Set()
    for (const [key, runs] of tiles) {
      const quads = runs.length / 4
      const pos = new Float32Array(quads * 4 * 3)
      const idx = new Uint32Array(quads * 6)
      for (let q = 0; q < quads; q++) {
        const i0 = runs[q * 4]
        const i1 = runs[q * 4 + 1]
        const j = runs[q * 4 + 2]
        const y = runs[q * 4 + 3]
        // Cell CENTRES are the sim grid's convention, so a run covering cells
        // i0..i1-1 spans from half a cell before i0 to half a cell before i1.
        const x0 = -WORLD_HALF + i0 * cell
        const x1 = -WORLD_HALF + i1 * cell
        const z0 = -WORLD_HALF + j * cell
        const z1 = z0 + cell
        const v = q * 12
        pos[v] = x0; pos[v + 1] = y; pos[v + 2] = z0
        pos[v + 3] = x1; pos[v + 4] = y; pos[v + 5] = z0
        pos[v + 6] = x1; pos[v + 7] = y; pos[v + 8] = z1
        pos[v + 9] = x0; pos[v + 10] = y; pos[v + 11] = z1
        const a = q * 4
        const o = q * 6
        idx[o] = a; idx[o + 1] = a + 2; idx[o + 2] = a + 1
        idx[o + 3] = a; idx[o + 4] = a + 3; idx[o + 5] = a + 2
        seen.add(y)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setIndex(new THREE.BufferAttribute(idx, 1))
      // Every surface is horizontal and upward, so the normals are known and
      // computeVertexNormals would only rediscover them slowly.
      const nrm = new Float32Array(quads * 4 * 3)
      for (let k = 1; k < nrm.length; k += 3) nrm[k] = 1
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, this.material)
      mesh.name = `water-${key}`
      this.lakes.add(mesh)
      this.triangles += quads * 2
    }
    this.bodies = seen.size
    return { tiles: tiles.size, triangles: this.triangles, levels: this.bodies }
  }

  clear() {
    for (const m of this.lakes.children) m.geometry.dispose()
    this.lakes.clear()
    this.bodies = 0
    this.triangles = 0
  }

  /**
   * The water surface above a point, or null on dry land. One array lookup, so
   * it is cheap enough for the scatter to ask about every candidate prop.
   *
   * Uses the UNDILATED mask. The dilation exists to bury the polygon edge under
   * the terrain, and treating that ring as wet would strip a 16 m band of trees
   * off every shoreline.
   */
  levelAt(x, z) {
    if (!this.mask) return null
    const i = Math.floor((x + WORLD_HALF) / this.cell)
    const j = Math.floor((z + WORLD_HALF) / this.cell)
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return null
    const c = j * this.n + i
    return this.mask[c] ? this.maskLevel[c] : null
  }
}
