import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { FADE_FRAGMENT, FADE_VERTEX, IGN_GLSL, getWindEnabled, propClockUniform, registerWindMaterial } from '../material.js'

// ---------------------------------------------------------------------------
// GRASS AS GEOMETRY, NOT AS A CUTOUT.
//
// The bed in src/v2/render/grass.js draws alpha-tested cards. It was measured on
// a Quest 2 at 20.6 full eyes of fragments per eye per frame, and the tuft
// texture it samples is 18.9% OPAQUE -- so ~81% of that work is a Lambert term,
// a wind bend and a texture-array fetch computed in full and then thrown away by
// `discard`. On a tiled Adreno the presence of that `discard` also turns off
// low-resolution-Z for the whole draw, so none of the occluded layers get
// rejected before shading either. Overdraw is the binding cost, and the card is
// mostly a machine for generating it.
//
// This module is the other end of the trade: a clump is ten triangles, one per
// blade, opaque, untextured, no alpha channel anywhere in the material. The
// covered area is only the part that used to be opaque, ~3.9 eyes rather than
// 20.6. The bill moves from fill, which this headset has none of, to vertices
// and triangles, which it has plenty of.
//
// The bed does carry ONE `discard`, in the rim dissolve, and it costs the draw
// its low-resolution-Z -- see the fade block in createBladeMaterial for the
// trade and the way out of it if the headset objects. The 3.9-against-20.6 win
// is a geometry fact and survives it; what is given up is the early rejection of
// blades that a nearer blade covers.
//
// WHAT ELSE GOES AWAY WITH THE CARD, none of which is a bonus so much as the
// reason the card was the problem:
//   - the stereo mismatch, because a cylindrical billboard is a single
//     orientation shown to two eyes that are 64 mm apart;
//   - the fawning, because a card that yaws to face you tips its painted blades
//     toward you as you look down and the whole bed appears to bow;
//   - the cutout silhouette, legible as a flat stamp from anywhere inside ~8 m;
//   - the wasted instance, because a card seen edge-on is a line. Ten blades at
//     ten yaws inside one clump have no degenerate viewing angle.
//
// WHAT IT COSTS, stated plainly so the trade can be read: a blade is thinner
// than a pixel past roughly 5 m (Quest 2 is ~0.00086 rad/px, so an 8 mm blade
// subtends 2 px at 4.7 m), and a sub-pixel opaque triangle has no mip chain to
// fall back on, so the far field will crawl and sparkle in a way the card's
// mipped texture does not. The fill number stays good out there -- ten
// sub-pixel blades cost ~40 fragments where a 30 m card shades ~360 to keep
// ~68 -- so the far-field question is ALIASING, not cost, and it is the reason
// a distance ring of cards may still be wanted later. The case for one, the
// three cheaper things to try first, and the reason it reads badly from the air
// are all in design/attic/grass-distance-cards.md.
//
// THE BASE COLOUR IS THE TERRAIN'S, and that is what buys the missing alpha. A
// card fades out at its edges; a triangle ends. What stops the ending being
// visible is that the bottom vertices are painted with exactly the colour the
// ground under them is DRAWN in -- sampled per clump by the caller and handed
// over as InstancedMesh.setColorAt. So the clump grows out of the ground rather
// than being stuck on top of it, and grass on a snow margin or a road verge
// takes the colour of what it is standing in for free.
//
// Sampling that colour is the caller's job and not this module's, because the
// terrain's own drawn colour is a shader chain and not a function -- see
// TerrainTint in src/terrain/terrain-tint.js, which replays it on the CPU. The
// contract here is only that the FEET are (1,1,1), so whatever colour arrives
// lands on them untouched.
//
// THE THREE THINGS THAT MAKE A TIP DIFFERENT FROM A FOOT, and where each lives:
//   - the RAMP is geometry: `aBladeT` is 0 at the feet and 1 at the apex, and
//     the interpolator turns it into a gradient for free;
//   - the WARMTH is geometry too, baked into the tip's own vertex colour, since
//     every clump wants the same hue shift;
//   - the BRIGHTNESS is per instance, `aTipMul`, because a bed where every tip
//     is lighter than its own foot by the same factor reads as one two-tone
//     material stamped over and over. Half the clumps get a lighter tip and
//     half a darker one -- see `bladeTipMul`.
// No fragment work in any of it: the vertex stage multiplies, the interpolator
// blends, and the fragment stage is a Lambert term over a varying. There is no
// texture to sample and no alpha channel anywhere.
// ---------------------------------------------------------------------------

export const BLADE_DEFAULTS = {
  // TEN TRIANGLES, ONE PER BLADE. There is no second triangle making a quad --
  // a blade is a spike, base to point, and the taper IS the silhouette. Two
  // triangles per blade would buy a curve and double the bill for something
  // that is under a pixel wide by 5 m.
  blades: 10,
  // Mean blade height in metres, and the fraction either side of it.
  height: 0.30,
  heightVary: 0.20,
  // Base width. The blade closes to a point at the top, so the mean width over
  // its length is half this.
  width: 0.035,
  // How far from the clump's centre the feet scatter. Blades sit at a random
  // radius and a random yaw within this disc and lean OUTWARD in proportion to
  // how far out they start, which is what makes a clump read as a fountain
  // rather than as a bundle of sticks.
  //
  // 0.4 m is WIDER THAN THE CLUMP IS TALL, which is deliberate: at 10 blades a
  // tight clump reads as a tussock with bald ground between it and its
  // neighbours, and spreading the same ten blades over a disc bigger than the
  // spacing lets neighbouring clumps interleave instead of tiling. The cost is
  // a bigger bounding sphere per instance, which matters only if per-instance
  // culling ever comes back.
  clumpRadius: 0.40,
  // Apex offset as a fraction of blade height, at the rim of the clump.
  lean: 0.45,
  // Metres of the clump buried. The instance is placed on the FIELD height and
  // the terrain mesh chords across the field, so a clump on a coarse chunk can
  // stand slightly proud of the triangles actually drawn under it. Burying the
  // feet hides that, and it costs nothing because a buried vertex is clipped by
  // the depth test rather than shaded.
  //
  // 0 because the feet now match the ground they stand on closely enough that
  // the seam does not read, which is the better fix: a buried foot is a foot
  // whose (1,1,1) vertex is under the surface, so the blade starts partway up
  // its own gradient and the base colour it was given never reaches the eye.
  sink: 0,
  // HOW FAR THE NORMAL IS BENT TOWARD STRAIGHT UP, 0 = the true face normal.
  // A blade lit by its own normal goes black whenever it turns edge-on to the
  // sun, and a field of them turns into salt-and-pepper noise that no amount of
  // density fixes.
  //
  // 1.0, ALL THE WAY, and the reason is the low sun. Anything short of 1 leaves
  // a share of the face normal in, and the residual tilt is much larger than it
  // sounds: 0.70 leaves blades 20-25 degrees off vertical. That is invisible at
  // noon -- dotNL spans 0.58 to 0.98 across a clump, a 1.7x ratio the eye reads
  // as shape -- and ruinous at dawn, where the sun's own elevation is smaller
  // than the tilt: at 10 degrees the same ten blades span 0.00 to 0.49, so one
  // blade is black and the blade touching it is fully lit. The world clock here
  // runs an hour a minute, so the bed spends most of its time in that regime.
  //
  // At 1 every blade normal is exactly (0,1,0) and the whole clump shades as
  // one, which is the point: the base of a blade is meant to be the ground it
  // is standing in, and the tip ramp is where the bed gets its relief instead.
  normalUp: 1.0,
  // TIP BRIGHTNESS, AS TWO RANGES AND NOTHING BETWEEN THEM. Per clump, not per
  // blade: a clump is one plant and its blades are the same age.
  //
  // A clump is either LIGHTER than its own foot by at least tipGain, or DARKER
  // by at least the same factor -- 1.5 and 1/1.5 here -- and tipVary is how much
  // further than that floor it may go. The gap around 1.0 is the whole design:
  // a tip the same colour as its base is a flat triangle, which is what the bed
  // must never draw, and a distribution centred anywhere puts a share of the
  // clumps there no matter how wide it is.
  //
  // THE DARK SIDE IS THE RECIPROCAL, not `2 - tipGain`. Brightness is read
  // multiplicatively, so 1/1.5 is as far below the base as 1.5 is above it and
  // the bed has no overall direction. It also cannot go negative, which a
  // subtraction can.
  //
  // The separation is read in LINEAR light and shown through a tone map and an
  // sRGB encode, both of which compress it: a 20% linear step is under 10% of a
  // code value by the time it reaches the eye, which is why the floor sits at
  // 1.5x rather than somewhere politer. tipGain must exceed 1 -- at 1 the two
  // ranges meet at the base colour and the guarantee is gone.
  tipGain: 1.5,
  tipVary: 0.4,
  // Pushes red up and blue down at the tip, for sun-bleached ends.
  tipWarm: 0.0,
}

/**
 * The per-clump tip brightness, as a multiplier over the base colour. Feed it
 * to the bed as the `aTipMul` instanced attribute.
 *
 * TWO RANGES, NOT ONE SPREAD. A coin flip picks lighter or darker and the
 * magnitude is drawn from `[tipGain, tipGain + tipVary]`, taken as itself or as
 * its reciprocal. Nothing is ever drawn between them, so the returned
 * multiplier cannot land near 1 and no clump can be handed a tip the colour of
 * its own foot -- see BLADE_DEFAULTS.tipGain.
 *
 * @param {object} params  BLADE_DEFAULTS, or an override of it
 * @param {() => number} rand  a 0..1 source; two draws are taken
 */
export function bladeTipMul(params, rand) {
  const p = { ...BLADE_DEFAULTS, ...params }
  if (!(p.tipGain > 1)) throw new Error(`grass-blades: tipGain must exceed 1, got ${p.tipGain}`)
  if (!(p.tipVary >= 0)) throw new Error(`grass-blades: tipVary cannot be negative, got ${p.tipVary}`)
  const lighter = rand() < 0.5
  const step = p.tipGain + p.tipVary * rand()
  return lighter ? step : 1 / step
}

/**
 * One clump: `blades` triangles, scattered and leaning outward, ready to be
 * drawn by an InstancedMesh.
 *
 * Non-indexed on purpose. Every blade owns its three vertices outright -- they
 * carry a face normal, a base-or-tip colour and a base-or-tip ramp coordinate,
 * and no two blades agree on any of the three -- so an index buffer would save
 * nothing and cost a level of indirection.
 *
 * @param {object} params  BLADE_DEFAULTS, or an override of it
 * @param {number} seed
 * @returns {THREE.BufferGeometry} with position, normal, color, aBladeT and
 *   aBladeSeed
 */
export function buildBladeClump(params = {}, seed = 1) {
  const p = { ...BLADE_DEFAULTS, ...params }
  if (!(p.blades >= 1)) throw new Error(`grass-blades: need at least one blade, got ${p.blades}`)
  if (!(p.height > 0)) throw new Error(`grass-blades: height must be positive, got ${p.height}`)

  const rand = mulberry32(seed * 2654435761 + 17)
  const n = Math.round(p.blades)
  const pos = new Float32Array(n * 9)
  const nrm = new Float32Array(n * 9)
  const col = new Float32Array(n * 9)
  const ramp = new Float32Array(n * 3)
  const jitter = new Float32Array(n * 3)

  // The tip colour, resolved once. HUE ONLY -- warm pushes red up and blue down
  // about a green of exactly 1, so the tip is bleached without being brighter.
  // Brightness is `aTipMul`, per instance, and multiplying it in here as well
  // would be the same number applied twice.
  const tipR = Math.max(0, 1 + p.tipWarm)
  const tipG = 1
  const tipB = Math.max(0, 1 - p.tipWarm)

  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const fn = new THREE.Vector3()

  for (let b = 0; b < n; b++) {
    // Uniform over the disc, which needs the sqrt -- without it every clump is
    // dense in the middle and bald at the rim, and since the lean is keyed to
    // radius that would also flatten the fountain.
    const rr = p.clumpRadius * Math.sqrt(rand())
    const ra = rand() * Math.PI * 2
    const bx = Math.cos(ra) * rr
    const bz = Math.sin(ra) * rr

    const h = p.height * (1 + p.heightVary * (rand() * 2 - 1))
    // The blade's own plane. Independent of where its foot sits, so a clump
    // presents blades at every yaw and none of the viewing angles is a sliver.
    const yaw = rand() * Math.PI * 2
    const wx = Math.cos(yaw) * p.width * 0.5
    const wz = Math.sin(yaw) * p.width * 0.5

    // Lean outward, in proportion to how far out the foot is: the middle of the
    // clump stands up, the rim splays. A little jitter on top so the fountain
    // is not a perfect cone.
    const splay = p.lean * h * (rr / Math.max(1e-6, p.clumpRadius))
    const jx = (rand() * 2 - 1) * p.lean * h * 0.18
    const jz = (rand() * 2 - 1) * p.lean * h * 0.18
    const ax = bx + (rr > 1e-6 ? (bx / rr) * splay : 0) + jx
    const az = bz + (rr > 1e-6 ? (bz / rr) * splay : 0) + jz

    const o = b * 9
    // base left, base right, apex
    pos[o + 0] = bx - wx; pos[o + 1] = -p.sink; pos[o + 2] = bz - wz
    pos[o + 3] = bx + wx; pos[o + 4] = -p.sink; pos[o + 5] = bz + wz
    pos[o + 6] = ax; pos[o + 7] = h - p.sink; pos[o + 8] = az

    e1.set(pos[o + 3] - pos[o + 0], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2])
    e2.set(pos[o + 6] - pos[o + 0], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2])
    fn.crossVectors(e1, e2)
    if (fn.lengthSq() < 1e-12) throw new Error(`grass-blades: degenerate blade ${b} (width or height is zero)`)
    fn.normalize()
    // Bend toward up. Renormalised, so normalUp = 1 is a clean (0,1,0) rather
    // than a shortened vector that would quietly darken the whole bed.
    fn.set(fn.x * (1 - p.normalUp), fn.y * (1 - p.normalUp) + p.normalUp, fn.z * (1 - p.normalUp)).normalize()
    for (let v = 0; v < 3; v++) {
      nrm[o + v * 3] = fn.x; nrm[o + v * 3 + 1] = fn.y; nrm[o + v * 3 + 2] = fn.z
    }

    // (1,1,1) at the feet is what makes the instance colour land on the base
    // unmodified, which is the whole terrain-match trick.
    col[o + 0] = 1; col[o + 1] = 1; col[o + 2] = 1
    col[o + 3] = 1; col[o + 4] = 1; col[o + 5] = 1
    col[o + 6] = tipR; col[o + 7] = tipG; col[o + 8] = tipB

    ramp[b * 3] = 0; ramp[b * 3 + 1] = 0; ramp[b * 3 + 2] = 1

    // The blade's own number in 0..1, so the wind can tell one blade of a
    // bundle from another. It has to be constant across the triangle -- a value
    // that varies between the three corners tears the blade apart -- which is
    // why it cannot be hashed from the vertex position in the shader.
    //
    // It is the yaw draw rather than a fresh rand(): another call would shift
    // the stream and reshape every blade after this one, and a blade whose
    // stroke is tied to the plane it faces is the natural correlation anyway --
    // a blade bends across its width, not along it.
    jitter[b * 3] = jitter[b * 3 + 1] = jitter[b * 3 + 2] = yaw / (Math.PI * 2)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  // 0 at the feet, 1 at the apex. The tip brightness ramp interpolates on it,
  // and the wind squares it so a blade pivots about its foot instead of
  // shearing.
  geo.setAttribute('aBladeT', new THREE.BufferAttribute(ramp, 1))
  geo.setAttribute('aBladeSeed', new THREE.BufferAttribute(jitter, 1))
  geo.computeBoundingSphere()
  return geo
}

/**
 * The material a blade bed draws with: Lambert, vertex colours, no map, no
 * alpha of any kind.
 *
 * DoubleSide because a blade has a back and you will be standing among them.
 * That is cheaper here than it is for the card bed either way: a blade's back
 * face is the same few pixels as its front, where a card's is a full quad.
 *
 * PATCHED EITHER WAY. The wind is optional but the tip brightness is not: an
 * instanced bed without the `aTipMul` block draws every tip at exactly its
 * foot's colour, which is not a crash but is the whole gradient gone.
 *
 * `instancedFade` compiles the rim's dissolve in. See the fade block below for
 * why it dithers a blade at a time rather than a fragment at a time, the way
 * every other prop in the world does.
 *
 * @param {{wind?: boolean, instancedFade?: boolean}} opts
 * @returns {THREE.MeshLambertMaterial} with `.userData.uniforms` for the wind
 */
export function createBladeMaterial({ wind = true, instancedFade = false } = {}) {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  })

  const uniforms = {
    uTime: { value: 0 },
    uWindAmp: { value: 0.06 },
    uWindFreq: { value: 0.22 },
    uWindSpeed: { value: 0.9 },
  }
  material.userData.uniforms = uniforms

  material.onBeforeCompile = (shader) => {
    // The panel's wind row compiles the block out of every material in the
    // world at once (setWindEnabled), so the switch is read HERE, per compile,
    // and not folded into `wind` -- which only says whether this bed ever winds.
    const windOn = wind && getWindEnabled()
    Object.assign(shader.uniforms, uniforms)
    if (instancedFade) shader.uniforms.uPropClock = propClockUniform()
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute float aBladeT;
        #ifdef USE_INSTANCING
        attribute float aTipMul;
        #endif
        ${windOn ? /* glsl */ `
        // One number per blade, constant across its three vertices, so the wind
        // can tell one blade of a bundle from another. Not hashable from the
        // vertex position: the three corners of a blade disagree.
        attribute float aBladeSeed;
        ` : ''}
        ${instancedFade ? /* glsl */ `
        uniform float uPropClock;
        varying float vPropFade;
        // THE DEFINE IS MADE HERE, not inherited. createPropMaterial declares
        // the same attribute behind the same name for the card beds, and this
        // material is not built by it -- so without this line the fade block
        // below is dead GLSL and the bed pops instead of dissolving, silently
        // and with everything still compiling and linking.
        //
        // Behind USE_INSTANCING because the attribute is InstancedArena's:
        // undeclared it would read 0, and 0 is a clump scaled to nothing.
        #ifdef USE_INSTANCING
        #define PROP_FADE_ATTRIBUTE
        attribute float aPropFade;
        #endif
        ` : ''}
        ${windOn ? /* glsl */ `
        uniform float uTime;
        uniform float uWindAmp;
        uniform float uWindFreq;
        uniform float uWindSpeed;
        ` : ''}
      `)
      // AFTER color_vertex, which is where three folds the geometry's own
      // vertex colour and the instance colour together into vColor. The
      // geometry half is (1,1,1) at the feet and the tip HUE at the apex, the
      // instance half is the ground colour, and this is the brightness ramp
      // that the two of them deliberately leave out -- applied here, once per
      // vertex, so the interpolator delivers the blend for nothing.
      .replace('#include <color_vertex>', /* glsl */ `
        #include <color_vertex>
        #ifdef USE_INSTANCING
        vColor.rgb *= mix( 1.0, aTipMul, aBladeT );
        #endif
      `)

    // BOTH FACES OF A BLADE ARE THE SAME SURFACE. Three's double-sided path
    // flips the normal toward the viewer (`normal *= faceDirection` in
    // normal_fragment_begin), which is right for a solid seen from inside and
    // ruinous here: normalUp pushes every blade normal to within a few degrees
    // of straight up, so a back-facing blade is handed a normal pointing at the
    // ground, loses its dotNL against the sun entirely, and is left with the
    // hemisphere's near-black ground colour. Half of every clump goes black.
    // Undoing the flip (faceDirection twice is the identity) lights a fragment
    // by the normal the GEOMETRY authored, whichever side you are on -- the
    // same fix src/material.js makes for leaf cards, and for the same reason.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', /* glsl */ `
        #include <normal_fragment_begin>
        normal *= faceDirection;
      `)
    if (instancedFade) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
        #include <common>
        varying float vPropFade;
${IGN_GLSL}
      `)
        // AT color_fragment, the earliest point where diffuseColor exists. The
        // discard is worth putting as early as the chunk order allows: every
        // stipple hole that leaves here skips the Lambert term and the fog.
        .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
${FADE_FRAGMENT}
      `)
    }

    // AFTER begin_vertex, which is where `transformed` is created, and BEFORE
    // project_vertex, which is where three multiplies the instance matrix in.
    // Bending `transformed` therefore bends the blade in the CLUMP's local
    // space and inherits the instance's yaw and scale, so a bigger clump
    // sways further and a rotated one sways in its own frame.
    const bendGLSL = windOn ? /* glsl */ `
        #ifdef USE_INSTANCING
        {
          // The clump's world origin, which is what gives neighbouring clumps
          // different phases and makes the gust travel across the field rather
          // than every blade in the world nodding together.
          vec3 bladeRoot = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          // ONE NUMBER PER CLUMP, WITH NO sin IN IT. The fractional part of a
          // dot against an irrational pair decorrelates neighbouring positions
          // well enough for jitter and costs two ops, where the usual
          // sin-fract hash costs a transcendental on every vertex of the
          // densest bed in the world. Two of them, because a blade whose
          // stroke, rate, aim and reach all came off one number is a blade
          // whose four properties visibly move together.
          float clumpSeed = fract( dot( bladeRoot.xz, vec2( 0.7548776641, 0.5698402909 ) ) );
          float bladeA = fract( aBladeSeed + clumpSeed );
          float bladeB = fract( aBladeSeed * 3.77 + clumpSeed * 1.61 );
          // The clump's position still sets the base phase, which is what makes
          // a gust TRAVEL across the meadow rather than the whole field nodding
          // at once. Everything added to it is per blade: an offset, so no two
          // blades of a bundle are at the same point of the same stroke, and a
          // rate, so they do not fall back into step once they are out of it.
          float bladePhase = ( bladeRoot.x + bladeRoot.z * 0.7 ) * uWindFreq
            + bladeA * 6.2831853
            + uTime * uWindSpeed * ( 0.7 + 0.6 * bladeA );
          // AND ITS OWN AXIS, mostly downwind. The shared (1, 0.6) keeps the bed
          // reading as one wind; the crosswind term, signed and scaled per
          // blade, is what stops a clump moving like one rigid tuft. Not
          // normalised on purpose -- the varying length is per-blade reach,
          // which is the fourth thing that separates two blades of one plant.
          vec2 bladeDir = vec2( 1.0, 0.6 ) + vec2( -0.6, 1.0 ) * ( bladeB * 2.0 - 1.0 ) * 0.7;
          // SQUARED, so the feet do not move at all and the displacement grows
          // toward the tip. A linear ramp slides the whole blade sideways and
          // the bed looks like it is being dragged rather than blown.
          float bend = sin( bladePhase ) * uWindAmp * ( 0.65 + 0.7 * bladeB ) * aBladeT * aBladeT;
          transformed.xz += bladeDir * bend;
        }
        #endif
    ` : ''

    // THE RIM DISSOLVE IS THE SAME STIPPLE EVERY OTHER PROP USES, verbatim --
    // FADE_VERTEX resolves the instance's slot to a coverage fraction, and
    // FADE_FRAGMENT discards the fragments that fall outside it against
    // screen-space blue-ish noise. A clump therefore dissolves in place, at full
    // size, which is the only reading that looks like grass: a bundle scaled up
    // from nothing looks like it is growing, and shedding blade by blade looks
    // like it is being eaten.
    //
    // WHAT THAT COSTS, because this material exists to avoid exactly this: one
    // `discard` anywhere in a program turns off low-resolution-Z for the whole
    // draw on a tiled Adreno, so the bed loses the early rejection of its own
    // hidden blades. The overdraw win over the card bed is untouched -- the
    // blades cover ~3.9 eyes against the card's 20.6, and that is a geometry
    // fact, not a Z fact -- but the bed now shades some blades that a nearer one
    // covers. If the headset says no, the escape hatch is a SECOND draw for the
    // fading instances alone, with the discard compiled only into that program,
    // which needs the arena to keep the mid-fade slots contiguous.
    //
    // The two halves have to agree on `vPropFade`, which is why both are pulled
    // from material.js rather than written out here.
    const fadeGLSL = instancedFade ? FADE_VERTEX : ''

    if (bendGLSL || fadeGLSL) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        ${bendGLSL}
        ${fadeGLSL}
      `)
    }
  }
  // three keys its program cache on this alone, so the wind and no-wind builds
  // must not share it.
  material.customProgramCacheKey = () =>
    `grass-blade-v3${wind && getWindEnabled() ? '-wind' : '-nowind'}${instancedFade ? '-ifade' : ''}`
  // On the panel's wind switch, so pressing it recompiles the blades along with
  // the props. Without this the row would measure the world minus its meadow.
  if (wind) registerWindMaterial(material)
  return material
}
