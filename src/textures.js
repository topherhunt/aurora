import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Placeholder texture array.
//
// The shipping art direction is low-poly geometry with N64-resolution textures
// (Ocarina of Time / a lower-res Skyrim), NOT flat-shaded untextured low-poly.
// Real textures will come from Meshy and be downscaled in the Blender pass.
//
// These procedural tiles exist only so the spike exercises the real material
// path: one sampler2DArray, one material, alphaTest, mipmaps. They are not
// meant to look good.
//
// Why an array and not an atlas: 64px tiles packed into a shared atlas bleed
// into each other at coarse mip levels, and atlas tiles cannot wrap so you
// cannot tile bark up a trunk. Array layers mip and wrap independently while
// still costing exactly one texture binding.
// ---------------------------------------------------------------------------

export const TEX_SIZE = 64

// Layer indices. Vertex `texLayer` attributes point at these.
export const LAYER = {
  BARK: 0,
  BARK_BIRCH: 1,
  NEEDLES: 2,
  LEAVES: 3,
  ROCK: 4,
  SNOW: 5,
  DIRT: 6,
  GRASS: 7,
}
export const LAYER_COUNT = 8

// Deterministic value noise so the placeholder looks the same every run.
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function tile(fn, seed) {
  const n = TEX_SIZE
  const data = new Uint8Array(n * n * 4)
  const rand = mulberry32(seed)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      const [r, g, b, a] = fn(x / n, y / n, rand, x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return data
}

const mix = (a, b, t) => a + (b - a) * t

// Vertical streaking, which is what reads as bark at this resolution.
function bark(base, streak, seed) {
  return tile((u, v, rand) => {
    const s = Math.sin(u * Math.PI * 14 + Math.sin(v * 5) * 1.4) * 0.5 + 0.5
    const t = s * 0.6 + rand() * 0.4
    return [
      mix(base[0], streak[0], t),
      mix(base[1], streak[1], t),
      mix(base[2], streak[2], t),
      255,
    ]
  }, seed)
}

function mottled(base, alt, scale, seed) {
  return tile((u, v, rand) => {
    const s =
      Math.sin(u * Math.PI * scale) * Math.sin(v * Math.PI * scale) * 0.5 + 0.5
    const t = s * 0.5 + rand() * 0.5
    return [
      mix(base[0], alt[0], t),
      mix(base[1], alt[1], t),
      mix(base[2], alt[2], t),
      255,
    ]
  }, seed)
}

// Foliage carries genuine alpha cutouts so alphaTest is actually exercised
// rather than being a no-op that only bites us later.
function foliage(base, alt, seed, cutout) {
  return tile((u, v, rand) => {
    const s = Math.sin(u * Math.PI * 9) * Math.sin(v * Math.PI * 11) * 0.5 + 0.5
    const t = s * 0.55 + rand() * 0.45
    const a = cutout && rand() < 0.18 ? 0 : 255
    return [
      mix(base[0], alt[0], t),
      mix(base[1], alt[1], t),
      mix(base[2], alt[2], t),
      a,
    ]
  }, seed)
}

export function buildTextureArray() {
  const n = TEX_SIZE
  const layers = new Array(LAYER_COUNT)

  layers[LAYER.BARK] = bark([61, 43, 31], [96, 71, 52], 11)
  layers[LAYER.BARK_BIRCH] = bark([206, 202, 191], [74, 70, 66], 12)
  layers[LAYER.NEEDLES] = foliage([28, 56, 34], [52, 88, 51], 13, true)
  layers[LAYER.LEAVES] = foliage([46, 82, 40], [88, 122, 55], 14, true)
  layers[LAYER.ROCK] = mottled([92, 92, 96], [138, 137, 132], 7, 15)
  layers[LAYER.SNOW] = mottled([222, 230, 240], [255, 255, 255], 5, 16)
  layers[LAYER.DIRT] = mottled([94, 76, 58], [126, 106, 82], 9, 17)
  layers[LAYER.GRASS] = foliage([58, 92, 44], [96, 130, 62], 18, false)

  // DataArrayTexture wants one contiguous buffer, layers back to back.
  const data = new Uint8Array(n * n * 4 * LAYER_COUNT)
  for (let i = 0; i < LAYER_COUNT; i++) data.set(layers[i], i * n * n * 4)

  const tex = new THREE.DataArrayTexture(data, n, n, LAYER_COUNT)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  // Bilinear + mips is what the N64 actually did. Swap magFilter to
  // NearestFilter if we decide we want the crunchier PS1 look instead.
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
