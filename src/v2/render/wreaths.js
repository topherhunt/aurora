// Summit wreaths: the cloud that hangs on the highest peaks whatever the
// weather, so the skyline reads as far away (§10, "Summit wreaths").
//
// Opaque geometry, one draw. Every card of every wreath is one quad in one
// BufferGeometry: a vertical billboard the vertex stage turns to face her about
// its own axis, textured from the shaded cumulus atlas
// (public/world/cloud-cards.png, scripts/make-cloud-cards.mjs). Each card
// carries the ground plane under it, baked from public/world/summits.json, and
// the fragment fades out into the rock over GROUND_FADE_M, so a card sits into
// its mountain rather than cutting a line where the depth test meets it. The
// edge is dithered rather than blended: alpha is hashed against the pixel, the
// fragment discarded under the hash, with alphaToCoverage on so the MSAA
// resolve adds coverage levels. The mesh sits in the opaque pass with depth
// writes on, so the terrain occludes it, and it takes lighting.js's night
// envelope but not its aerial mix: that takes a ridge to the dark `haze`, and
// a cloud is as bright as the air in front of it, so distance takes a card to
// `fog`, the horizon the sky dome ends in, at AIR_SHARE of the ridge's rate --
// the cloud keeps its shading past the ridge it sits on, as a bright thing does.
//
// The discard costs the draw its low-resolution Z on Adreno (§28), so what is
// held small is the screen area: a card is culled in the vertex stage inside
// CULL_M of its centre, never faded, and her walk into a wreath becomes the fog
// closing in through hazeGain() instead.

import THREE from '../../three-instance.js'
import { HEAD_EYE_DECL, HEAD_EYE_GLSL, bindHeadEye } from '../../head-eye.js'
import { mulberry32 } from '../../sim/mathx.js'

export const CULL_M = 500
// The local haze starts to rise this far from a summit's centre and is at its
// full gain at the cull radius, so the cloud she can no longer see is the air.
export const HAZE_REACH_M = 1000
export const HAZE_GAIN = 2.5
// How far the cloud base descends at full cover, in metres.
export const LOWER_M = 140
// The share of hazeDensity a card fades to the horizon at: 1/e at 1.8 km on a
// clear noon where a ridge is at 0.9 km, and gone by 1.2 km under rain.
export const AIR_SHARE = 0.5

export const CARDS = [4, 7] // per summit, inclusive
export const WIDTH_M = [220, 480]
export const ASPECT = 0.5 // a tile is 256x128, so a card is half as tall as wide
export const TILES = 4 // across the atlas
// A card's centre sits this share of its height above the ground under it, so
// its base is in the rock and the fade takes it out there.
const SEAT = [0.2, 0.4]
export const GROUND_FADE_M = 50
// The other cards hang this far down the flanks at most, as a share of the
// footprint, each seated on the ground where it lands.
const SPREAD = 0.9

const VERTEX_GLSL = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aCorner;
  attribute vec2 aSize;
  attribute vec3 aGround;
  attribute vec2 aTile;
  uniform float uLower;
  uniform vec2 uHead;
  varying vec2 vCardUv;
  varying float vAbove;
`

const FRAGMENT_GLSL = /* glsl */ `
  uniform sampler2D uCards;
  uniform float uThick;
  uniform vec3 uAir;
  varying vec2 vCardUv;
  varying float vAbove;
`

// Takes the fog slot before lighting.patch looks for it, so its aerial mix is
// never emitted here. Output space, like that mix, so uAir is raw sRGB.
const AIR_GLSL = /* glsl */ `
  #ifdef USE_FOG
    #ifndef FOG_EXP2
      #error the wreaths need scene.fog to be a THREE.FogExp2
    #endif
    float airTau = vFogDepth * fogDensity * ${AIR_SHARE.toFixed(2)};
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uAir, 1.0 - exp( - airTau * airTau ) );
  #endif
`

// Interleaved gradient noise: a per-pixel threshold that is fixed to the
// pixel, so the fringe is a still stipple rather than a shimmer.
const ALPHA_GLSL = /* glsl */ `
  {
    vec4 card = texture2D( uCards, vCardUv );
    // The threshold rises in clear weather, so the sprite erodes to its dense
    // core; under a ceiling the whole sprite shows.
    float alpha = smoothstep( uThick, uThick + 0.5, card.a ) * smoothstep( 0.0, ${GROUND_FADE_M.toFixed(1)}, vAbove );
    diffuseColor.rgb *= card.r;
    float hash = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    // A threshold a quarter wide, placed so alpha 0 keeps no pixel and alpha 1
    // keeps every pixel whole; between, the kept share is alpha.
    float coverage = 5.0 * alpha - 4.0 * hash;
    if ( coverage <= 0.0 ) discard;
    diffuseColor.a = min( 1.0, coverage );
  }
`

export class Wreaths {
  /**
   * @param scene    THREE.Scene. Gets `mesh`.
   * @param summits  The parsed public/world/summits.json.
   * @param cards    The cloud card atlas (public/world/cloud-cards.png).
   * @param opts.patch  lighting.patch bound for a per-vertex material, or null
   *                    for a probe with no WorldLighting.
   */
  constructor(scene, summits, cards, { patch = null, seed = 1 } = {}) {
    if (!summits?.summits?.length || !summits.grid || !summits.footprint) throw new Error('Wreaths: summits.json has no summits, grid or footprint')
    if (!cards?.isTexture) throw new Error('Wreaths: needs the cloud card atlas')
    this.summits = summits.summits

    const rand = mulberry32(seed)
    const range = (lohi) => lohi[0] + rand() * (lohi[1] - lohi[0])
    const center = [], corner = [], size = [], groundAttr = [], tile = [], summit = [], index = []
    let count = 0
    for (const s of this.summits) {
      const ground = groundSampler(s, summits)
      const n = Math.round(range(CARDS))
      for (let i = 0; i < n; i++) {
        const w = range(WIDTH_M), h = w * ASPECT
        // The first card caps the peak; the rest hang about it.
        const spread = i === 0 ? 0 : rand() * (summits.footprint * SPREAD - w * 0.5)
        const a = rand() * Math.PI * 2
        const cx = s.x + Math.cos(a) * Math.max(0, spread), cz = s.z + Math.sin(a) * Math.max(0, spread)
        const gy = i === 0 ? s.y : ground(cx, cz)
        const cy = gy + h * range(SEAT)
        // The ground plane under the card: its height at the centre and its
        // slope, from the baked grid, for the fade to run against.
        const d = 40
        const gx = (ground(cx + d, cz) - ground(cx - d, cz)) / (2 * d)
        const gz = (ground(cx, cz + d) - ground(cx, cz - d)) / (2 * d)
        const t = Math.floor(rand() * TILES), flip = rand() < 0.5 ? -1 : 1
        for (let c = 0; c < 4; c++) {
          center.push(cx, cy, cz)
          corner.push(c & 1 ? 1 : -1, c & 2 ? 1 : -1)
          size.push(w, h)
          groundAttr.push(gy, gx, gz)
          tile.push(t, flip)
          summit.push(s.x, s.z)
        }
        const v = count * 4
        index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3)
        count++
      }
    }
    this.count = count
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('aCenter', new THREE.Float32BufferAttribute(center, 3))
    geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2))
    geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 2))
    geometry.setAttribute('aGround', new THREE.Float32BufferAttribute(groundAttr, 3))
    geometry.setAttribute('aTile', new THREE.Float32BufferAttribute(tile, 2))
    geometry.setAttribute('aSummit', new THREE.Float32BufferAttribute(summit, 2))
    geometry.setIndex(index)
    // No position attribute: the vertex stage places every quad about aCenter.
    // The cards span the world, so the mesh is never frustum-culled as one sphere.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)

    this.uniforms = {
      uCards: { value: cards },
      uThick: { value: 0 },
      uLower: { value: 0 },
      uHead: { value: new THREE.Vector2(1e9, 1e9) },
      uAir: { value: new THREE.Vector3(1, 1, 1) },
    }
    // Front faces only: the quad winds counter-clockwise as she sees it, always.
    const material = new THREE.MeshLambertMaterial({ color: 0xe6e9ee, side: THREE.FrontSide })
    material.alphaToCoverage = true
    const u = this.uniforms
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u)
      bindHeadEye(shader.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${HEAD_EYE_DECL}\n${VERTEX_GLSL}`)
        // The card turns about its axis to face her; its normal leans up and
        // toward her, so a cloud between her and the sun is the darker one.
        .replace('#include <beginnormal_vertex>', `
          vec3 toCam = ${HEAD_EYE_GLSL} - aCenter;
          vec3 bbFace = normalize( vec3( toCam.x, 0.0, toCam.z ) + vec3( 1e-4, 0.0, 0.0 ) );
          vec3 bbRight = vec3( bbFace.z, 0.0, -bbFace.x );
          vec3 objectNormal = normalize( bbFace + vec3( 0.0, 1.0, 0.0 ) );`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = aCenter + bbRight * ( aCorner.x * aSize.x * 0.5 ) + vec3( 0.0, aCorner.y * aSize.y * 0.5 - uLower, 0.0 );
          float groundY = aGround.x + aGround.y * ( transformed.x - aCenter.x ) + aGround.z * ( transformed.z - aCenter.z );
          vAbove = transformed.y - groundY;
          vCardUv = vec2( ( aTile.x + 0.5 + aTile.y * aCorner.x * 0.5 ) / ${TILES.toFixed(1)}, aCorner.y * 0.5 + 0.5 );`)
        // Behind the far plane, and w positive so the clipper drops the whole
        // triangle rather than dividing by zero.
        .replace('#include <project_vertex>', `#include <project_vertex>
          if ( distance( aCenter.xz, uHead ) < ${CULL_M.toFixed(1)} ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_GLSL}`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${ALPHA_GLSL}`)
        .replace('#include <fog_fragment>', AIR_GLSL)
    }
    material.customProgramCacheKey = () => 'v2-wreaths'
    if (patch) patch(material)
    this.material = material

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'wreaths'
    // After the terrain and every prop at 0, so the discard's lost early-Z
    // costs only the fragments the ground did not already fill.
    this.mesh.renderOrder = 10
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }

  get visible() { return this.mesh.visible }
  set visible(on) { this.mesh.visible = on }

  /** Per frame: the cover, the horizon colour and where she stands. */
  update(head, state) {
    const u = this.uniforms
    // Thickens with cover: at 0 a card is its dense core, at 1 the whole sprite.
    u.uThick.value = 0.4 - 0.4 * state.cover
    u.uLower.value = LOWER_M * state.cover
    u.uHead.value.set(head.x, head.z)
    u.uAir.value.set(state.fog[0], state.fog[1], state.fog[2])
  }

  /**
   * The multiplier on hazeDensity for where she stands: 1 clear of every
   * wreath, HAZE_GAIN at a culled wreath's centre.
   */
  hazeGain(head) {
    let near = Infinity
    for (const s of this.summits) near = Math.min(near, Math.hypot(s.x - head.x, s.z - head.z))
    const t = Math.max(0, Math.min(1, (HAZE_REACH_M - near) / (HAZE_REACH_M - CULL_M)))
    return 1 + (HAZE_GAIN - 1) * t * t * (3 - 2 * t)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

// Bilinear read of a summit's baked ground grid, clamped at its edge.
function groundSampler(s, { grid, footprint }) {
  const cell = (2 * footprint) / (grid - 1)
  return (x, z) => {
    const fx = Math.max(0, Math.min(grid - 1.001, (x - s.x + footprint) / cell))
    const fz = Math.max(0, Math.min(grid - 1.001, (z - s.z + footprint) / cell))
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j
    const g = s.ground
    const a = g[j * grid + i] * (1 - tx) + g[j * grid + i + 1] * tx
    const b = g[(j + 1) * grid + i] * (1 - tx) + g[(j + 1) * grid + i + 1] * tx
    return a * (1 - tz) + b * tz
  }
}
