import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'

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
// 20.6, and because nothing discards, LRZ comes back and the hidden ones die
// before they are shaded. The bill moves from fill, which this headset has none
// of, to vertices and triangles, which it has plenty of.
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
// `terrainTint` in src/gen-grass-main.js. The contract here is only that the
// FEET are (1,1,1), so whatever colour arrives lands on them untouched.
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
// texture to sample and no alpha to test.
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
  // density fixes. Leaning the normal toward the ground's up-vector is the
  // standard dodge: the clump then shades like the hillside it is standing on,
  // which is also what the eye expects from grass seen at any distance.
  normalUp: 0.70,
  // The MEAN tip brightness, as a multiplier over the terrain base colour, and
  // the spread either side of it. Per clump, not per blade: a clump is one
  // plant and its blades are the same age.
  //
  // 1.0 +/- 0.35 means no clump gets a tip the same brightness as its own foot
  // -- the sign is drawn per clump but the MAGNITUDE never lands near zero, so
  // every clump has a gradient in it and the bed as a whole has no single
  // direction. The spread is read in LINEAR light and shown through a tone map
  // and an sRGB encode, both of which compress it: a 20% linear step is under
  // 10% of a code value by the time it reaches the eye, which is why the floor
  // sits where it does rather than somewhere politer. Set tipVary to 0 and
  // tipGain above 1 for the plainer reading: every tip lighter than its own
  // base by the same amount.
  tipGain: 1.0,
  tipVary: 0.35,
  // Pushes red up and blue down at the tip, for sun-bleached ends.
  tipWarm: 0.0,
}

/**
 * The per-clump tip brightness, as a multiplier over the base colour. Feed it
 * to the bed as the `aTipMul` instanced attribute.
 *
 * The sign is a coin flip and the magnitude covers only the top half of
 * `tipVary`, which is what guarantees contrast: drawing the whole multiplier
 * uniformly from `1 +/- tipVary` puts a share of the clumps at ~1.0, and a
 * clump whose tip matches its foot has no gradient at all.
 *
 * @param {object} params  BLADE_DEFAULTS, or an override of it
 * @param {() => number} rand  a 0..1 source; two draws are taken
 */
export function bladeTipMul(params, rand) {
  const p = { ...BLADE_DEFAULTS, ...params }
  const sign = rand() < 0.5 ? -1 : 1
  return Math.max(0, 1 + sign * p.tipVary * (0.55 + 0.45 * rand())) * p.tipGain
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
 * @returns {THREE.BufferGeometry} with position, normal, color and aBladeT
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
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  // 0 at the feet, 1 at the apex. The tip brightness ramp interpolates on it,
  // and the wind squares it so a blade pivots about its foot instead of
  // shearing.
  geo.setAttribute('aBladeT', new THREE.BufferAttribute(ramp, 1))
  geo.computeBoundingSphere()
  return geo
}

/**
 * The material a blade bed draws with: Lambert, vertex colours, no map, no
 * alpha of any kind.
 *
 * DoubleSide because a blade has a back and you will be standing among them.
 * That is free here in a way it is not for the card bed: with no alphaTest
 * there is no `discard`, so the tiler keeps its hidden-surface removal and a
 * back face that is behind something never reaches the fragment stage.
 *
 * PATCHED EITHER WAY. The wind is optional but the tip brightness is not: an
 * instanced bed without the `aTipMul` block draws every tip at exactly its
 * foot's colour, which is not a crash but is the whole gradient gone.
 *
 * @param {{wind?: boolean}} opts
 * @returns {THREE.MeshLambertMaterial} with `.userData.uniforms` for the wind
 */
export function createBladeMaterial({ wind = true } = {}) {
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
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute float aBladeT;
        #ifdef USE_INSTANCING
        attribute float aTipMul;
        #endif
        ${wind ? /* glsl */ `
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

    if (!wind) return

    // AFTER begin_vertex, which is where `transformed` is created, and BEFORE
    // project_vertex, which is where three multiplies the instance matrix in.
    // Bending `transformed` therefore bends the blade in the CLUMP's local
    // space and inherits the instance's yaw and scale, so a bigger clump
    // sways further and a rotated one sways in its own frame.
    shader.vertexShader = shader.vertexShader
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          // The clump's world origin, which is what gives neighbouring clumps
          // different phases and makes the gust travel across the field rather
          // than every blade in the world nodding together.
          vec3 bladeRoot = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          float bladePhase = ( bladeRoot.x + bladeRoot.z * 0.7 ) * uWindFreq + uTime * uWindSpeed;
          // SQUARED, so the feet do not move at all and the displacement grows
          // toward the tip. A linear ramp slides the whole blade sideways and
          // the bed looks like it is being dragged rather than blown.
          float bend = sin( bladePhase ) * uWindAmp * aBladeT * aBladeT;
          transformed.x += bend;
          transformed.z += bend * 0.6;
        }
        #endif
      `)
  }
  // three keys its program cache on this alone, so the wind and no-wind builds
  // must not share it.
  material.customProgramCacheKey = () => (wind ? 'grass-blade-v3-wind' : 'grass-blade-v3-nowind')
  return material
}
