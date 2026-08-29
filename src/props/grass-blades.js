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
// ground under them is painted with -- terrain/chunk-mesh-v2.js's `shade`, the
// same function the chunk mesh calls, sampled per clump and delivered as
// InstancedMesh.setColorAt. So the clump grows out of the ground rather than
// being stuck on top of it, and grass on a snow margin or a road verge takes
// the colour of what it is standing in for free.
//
// The ramp along the blade rides in the geometry's OWN vertex colours, which
// three multiplies by the instance colour in `color_vertex`. Base is (1,1,1),
// so the foot of every blade is the terrain colour untouched; the tip is
// `tipGain` warmed by `tipWarm`. Two attributes and no fragment work: the
// interpolator does the gradient, and the fragment stage is a Lambert term over
// a varying. There is no texture to sample and no alpha to test.
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
  width: 0.022,
  // How far from the clump's centre the feet scatter. Blades sit at a random
  // radius and a random yaw within this disc and lean OUTWARD in proportion to
  // how far out they start, which is what makes a clump read as a fountain
  // rather than as a bundle of sticks.
  clumpRadius: 0.10,
  // Apex offset as a fraction of blade height, at the rim of the clump.
  lean: 0.45,
  // Metres of the clump buried. The instance is placed on the FIELD height and
  // the terrain mesh chords across the field, so a clump on a coarse chunk can
  // stand slightly proud of the triangles actually drawn under it. Burying the
  // feet hides that, and it costs nothing because a buried vertex is clipped by
  // the depth test rather than shaded.
  sink: 0.03,
  // HOW FAR THE NORMAL IS BENT TOWARD STRAIGHT UP, 0 = the true face normal.
  // A blade lit by its own normal goes black whenever it turns edge-on to the
  // sun, and a field of them turns into salt-and-pepper noise that no amount of
  // density fixes. Leaning the normal toward the ground's up-vector is the
  // standard dodge: the clump then shades like the hillside it is standing on,
  // which is also what the eye expects from grass seen at any distance.
  normalUp: 0.70,
  // The tip colour, as a multiplier over the terrain base. Under 1 darkens.
  //
  // 0.85 IS THE PLAYER'S CALL, NOT THE PHYSICAL ONE. Ambient occlusion argues
  // the other way -- the base of a clump is the part shadowed by its own
  // neighbours and the tip is the part catching sky -- so a value above 1 is
  // the defensible default and this one is a look. The slider spans both.
  tipGain: 0.85,
  // Pushes red up and blue down at the tip, for sun-bleached ends.
  tipWarm: 0.0,
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

  // The tip colour, resolved once. Warm pushes red up and blue down about the
  // gain so that the tip can be bleached without also being brighter.
  const tipR = Math.max(0, p.tipGain * (1 + p.tipWarm))
  const tipG = Math.max(0, p.tipGain)
  const tipB = Math.max(0, p.tipGain * (1 - p.tipWarm))

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
  // The wind reads this and nothing else does. Squared in the shader, so a
  // blade pivots about its foot instead of shearing.
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
  if (!wind) {
    material.customProgramCacheKey = () => 'grass-blade-v1-nowind'
    return material
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute float aBladeT;
        uniform float uTime;
        uniform float uWindAmp;
        uniform float uWindFreq;
        uniform float uWindSpeed;
      `)
      // AFTER begin_vertex, which is where `transformed` is created, and BEFORE
      // project_vertex, which is where three multiplies the instance matrix in.
      // Bending `transformed` therefore bends the blade in the CLUMP's local
      // space and inherits the instance's yaw and scale, so a bigger clump
      // sways further and a rotated one sways in its own frame.
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
  material.customProgramCacheKey = () => 'grass-blade-v1-wind'
  return material
}
