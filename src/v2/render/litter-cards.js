import THREE from '../../three-instance.js'
import { HEAD_EYE_DECL, HEAD_EYE_GLSL, bindHeadEye } from '../../head-eye.js'
import { FADE_FRAGMENT, FADE_VERTEX, IGN_GLSL, propClockUniform } from '../../material.js'
import { TEX_SIZE } from '../../textures.js'
import { AXIS_VIEWS, HUE_FRAGMENT, SPUN_VIEWS, bakeCritterCard, billboardVertex, critterCardExtents, spunBounds } from './critters.js'
import { CARD_NORMAL } from './gen-props.js'
import { PropMeshes } from './prop-arena.js'

// ---------------------------------------------------------------------------
// THE LITTER CARDS. Every far card of the ground litter (stumps, logs, skeletons, skulls, mushrooms) is one instance of ONE unit quad in ONE InstancedMesh, so the whole band is a single draw call however many kinds there are. A layer's instance carries its picture index in `aLayerShift` (PropArena `cards`); the quad's extents come from a uniform row per picture and its picture from a layer of one 128 px array.
//
// A picture is SPUN (the quad turns about the instance's Y to face her, billboardVertex), AXIAL (the piece lies along its own Z and its card turns only about that axis, to the eye as seen in the piece's own frame; one quad stands in for the crossed pair a log used to need) or FIXED (the quad stays in the XY plane the instance matrix put it in: a face on a wall).
//
// Pictures are stored top row first (the prop atlas's order); critter bakes arrive bottom row first and `setCritterPixels` flips them.
// ---------------------------------------------------------------------------

export const MAX_PICTURES = 32

const SPUN = 0
const AXIAL = 1
const FIXED = 2

const VERTEX_COMMON = /* glsl */ `
  #define PROP_FADE_ATTRIBUTE
  attribute float aPropFade;
  attribute float aLayerShift;
  attribute float aHue;
  varying float vHue;
  uniform float uPropClock;
  uniform vec4 uCardBox[${MAX_PICTURES}];
  uniform float uCardKind[${MAX_PICTURES}];
  uniform float uCardTilt[${MAX_PICTURES}];
  varying float vPropFade;
  varying vec2 vCardUv;
  flat varying float vCardLayer;
  ${HEAD_EYE_DECL}`

// uCardBox is (cx, cy, halfWidth, halfHeight) in the instance's frame. Spun and fixed: the picture stands in the XY plane centred at (cx, cy). Axial: the picture runs along -Z, centred on the axis through (cx, cy) and turned about it to face the eye.
const VERTEX_BODY = /* glsl */ `
  {
    float cardId = floor( aLayerShift + 0.5 );
    int ci = int( cardId );
    vec4 cb = uCardBox[ ci ];
    vCardLayer = cardId;
    vHue = aHue;
    vCardUv = vec2( position.x + 0.5, 0.5 - position.y );
    if ( uCardKind[ ci ] > 1.5 ) {
      transformed = vec3( cb.x + 2.0 * position.x * cb.z, cb.y + 2.0 * position.y * cb.w, 0.0 );
    } else if ( uCardKind[ ci ] > 0.5 ) {
      mat4 cim = modelMatrix * instanceMatrix;
      vec3 cd = ${HEAD_EYE_GLSL} - cim[ 3 ].xyz;
      vec2 ce = vec2( dot( cim[ 0 ].xyz, cd ) / dot( cim[ 0 ].xyz, cim[ 0 ].xyz ), dot( cim[ 1 ].xyz, cd ) / dot( cim[ 1 ].xyz, cim[ 1 ].xyz ) ) - cb.xy;
      float cl = length( ce );
      vec2 cu = cl > 1e-4 ? vec2( -ce.y, ce.x ) / cl : vec2( 0.0, 1.0 );
      if ( ce.x < 0.0 ) cu = -cu;
      transformed = vec3( cb.xy + cu * ( 2.0 * position.y * cb.w ), -2.0 * position.x * cb.z );
    } else {
      transformed = vec3( cb.x + 2.0 * position.x * cb.z, cb.y + 2.0 * position.y * cb.w, 0.0 );
      ${billboardVertex(false, 'vCardUv', 'uCardTilt[ ci ]')}
    }
    ${FADE_VERTEX}
  }`

const FRAGMENT_COMMON = /* glsl */ `
  varying float vPropFade;
  varying vec2 vCardUv;
  varying float vHue;
  flat varying float vCardLayer;
  uniform highp sampler2DArray uCardPics;
  ${IGN_GLSL}`

/** The extents of the card for a piece of `bounds` (setCritterAsset's): `{ kind, cx, cy, hw, hh }` for `addPicture`. `core` is where an axial piece's axis runs in its frame. A fixed card is the side view as it stands, `bounds` already the width it spans. */
export function cardPicture(kind, bounds, core = { x: 0, y: 0 }) {
  if (kind === 'fixed') {
    const ext = critterCardExtents(bounds)
    return { kind, cx: 0, cy: (ext.y0 + ext.y1) / 2, hw: ext.hx, hh: (ext.y1 - ext.y0) / 2 }
  }
  if (kind === 'axial') {
    const ext = critterCardExtents(bounds)
    return { kind, cx: core.x, cy: core.y, hw: ext.hz, hh: (ext.y1 - ext.y0) / 2 }
  }
  const ext = critterCardExtents(spunBounds(bounds))
  return { kind, cx: 0, cy: (ext.y0 + ext.y1) / 2, hw: ext.hx, hh: (ext.y1 - ext.y0) / 2 }
}

export class LitterCards {
  /**
   * @param capacity  instances the one mesh can hold, drawn at once across every layer.
   */
  constructor(capacity) {
    if (!(capacity > 0)) throw new Error(`LitterCards: need a positive capacity, got ${capacity}`)
    this.capacity = capacity
    this.claimed = 0
    this.owners = []
    this.pictures = 0
    this.box = Array.from({ length: MAX_PICTURES }, () => new THREE.Vector4())
    this.kind = new Float32Array(MAX_PICTURES)
    this.tilt = new Float32Array(MAX_PICTURES)

    const stride = TEX_SIZE * TEX_SIZE * 4
    this.stride = stride
    this.texture = new THREE.DataArrayTexture(new Uint8Array(stride * MAX_PICTURES), TEX_SIZE, TEX_SIZE, MAX_PICTURES)
    this.texture.format = THREE.RGBAFormat
    this.texture.type = THREE.UnsignedByteType
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true

    this.material = this._material()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    this.meshes = new PropMeshes([{ geometries: [geo] }], [capacity], this.material, 'v2-litter-cards', { layerShift: true, hue: true })
    this.group = new THREE.Group()
    this.group.name = 'v2-litter-cards'
    for (const mesh of this.meshes.meshes) this.group.add(mesh)
  }

  /** Triangles in one card, for the layers' bills. */
  get cardTris() {
    return 2
  }

  /** Record `n` instances as `owner`'s worst case. The sum may exceed the capacity -- every layer's pool full at once with all of it far away does not happen -- so a real overflow is reported when the mesh actually fills (PropMeshes._room), not here. */
  claim(owner, n) {
    this.claimed += n
    this.owners.push(`${owner}:${n}`)
  }

  /** A new picture slot from `cardPicture`'s answer; returns its index, the value a layer writes with `setLayerShiftAt`. `tilt` pitches a spun card toward an eye above it by that fraction of her elevation (critters.js billboardVertex). */
  addPicture({ kind, cx, cy, hw, hh, tilt = 0 }) {
    if (kind !== 'spun' && kind !== 'axial' && kind !== 'fixed') throw new Error(`LitterCards: a picture is 'spun', 'axial' or 'fixed', not ${kind}`)
    if (this.pictures >= MAX_PICTURES) throw new Error(`LitterCards: ${MAX_PICTURES} pictures is the table's size`)
    if (!(hw > 0) || !(hh > 0)) throw new Error(`LitterCards: need a positive half width and height, got ${hw} x ${hh}`)
    if (!(tilt >= 0 && tilt <= 1)) throw new Error(`LitterCards: tilt must be in [0, 1], got ${tilt}`)
    if (tilt && kind !== 'spun') throw new Error(`LitterCards: only a spun picture tilts, not ${kind}`)
    const i = this.pictures++
    this.box[i].set(cx, cy, hw, hh)
    this.kind[i] = kind === 'axial' ? AXIAL : kind === 'fixed' ? FIXED : SPUN
    this.tilt[i] = tilt
    return i
  }

  /** Picture `i`'s texels, top row first, for a bake to write in place; call `upload` after. */
  pixels(i) {
    return this.texture.image.data.subarray(i * this.stride, (i + 1) * this.stride)
  }

  /** Copy texels already top row first (another layer of the prop atlas) into picture `i`. */
  setPixels(i, data) {
    if (data.length !== this.stride) throw new Error(`LitterCards: a picture is ${TEX_SIZE} px square, got ${data.length / 4} texels`)
    this.pixels(i).set(data)
    this.upload()
  }

  /** Copy a critter bake (bottom row first, TEX_SIZE square) into picture `i`. */
  setCritterPixels(i, data) {
    const row = TEX_SIZE * 4
    if (data.length !== this.stride) throw new Error(`LitterCards: a critter card is ${TEX_SIZE} px square, got ${data.length / 4} texels`)
    const dst = this.pixels(i)
    for (let y = 0; y < TEX_SIZE; y++) dst.set(data.subarray(y * row, (y + 1) * row), (TEX_SIZE - 1 - y) * row)
    this.upload()
  }

  /** Photograph `geometry` (wearing `map`) into picture `i`, as the `kind` of card it was added as. */
  bake(renderer, i, geometry, map, bounds, kind) {
    const texture = bakeCritterCard(renderer, geometry, map, kind === 'spun' ? spunBounds(bounds) : bounds, kind === 'axial' ? AXIS_VIEWS : SPUN_VIEWS)
    this.setCritterPixels(i, texture.image.data)
    texture.dispose()
  }

  upload() {
    this.texture.needsUpdate = true
  }

  _material() {
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaTest: 0.5, side: THREE.DoubleSide })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPropClock = propClockUniform()
      shader.uniforms.uCardBox = { value: this.box }
      shader.uniforms.uCardKind = { value: this.kind }
      shader.uniforms.uCardTilt = { value: this.tilt }
      shader.uniforms.uCardPics = { value: this.texture }
      bindHeadEye(shader.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_COMMON}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_COMMON}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\ndiffuseColor *= texture( uCardPics, vec3( vCardUv, vCardLayer ) );\n${HUE_FRAGMENT}\n${FADE_FRAGMENT}`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${CARD_NORMAL}`)
    }
    material.customProgramCacheKey = () => 'litter-card'
    return material
  }

  get stats() {
    return { capacity: this.capacity, claimed: this.claimed, used: this.meshes.meshes[0].count, pictures: this.pictures, refused: this.meshes.refused }
  }

  dispose() {
    this.meshes.dispose()
    this.texture.dispose()
    this.material.dispose()
  }
}
