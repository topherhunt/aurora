import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The one prop texture. Every prop texture in the world is a layer of this.
//
// The shipping art direction is low-poly geometry with N64-resolution textures
// (Ocarina of Time / a lower-res Skyrim), NOT flat-shaded untextured low-poly.
//
// WHY AN ARRAY AND NOT A PACKED ATLAS PNG. This is the load-bearing decision of
// the whole texture pipeline, and packing everything into one big image is the
// obvious idea that does not work:
//
//   Mips bleed. In a packed atlas the mip chain is built over the WHOLE image,
//   so at coarse levels a leaf averages with whatever tile sits next to it.
//   That is not "blurry at distance", which is fine and expected -- it is a
//   leaf turning bark-brown. Array layers each mip independently, so distance
//   blur stays within one texture and never picks up a neighbour's colour.
//
//   Atlas tiles cannot wrap. A sub-rectangle has no repeat mode, so bark cannot
//   tile up a trunk -- UVs past 1.0 walk into the next tile. Array layers get
//   the full [0,1] space and real RepeatWrapping, which is exactly what a trunk
//   needs and a frond card does not.
//
// And an array costs the same as an atlas at the thing atlases exist for: ONE
// texture binding, so one material, so BatchedMesh collapses everything into a
// single multi-draw call (DESIGN.md §5). We get the draw-call win without the
// two costs above.
//
// ONE MESH, SEVERAL LAYERS. `texLayer` is a per-VERTEX attribute, not a
// per-object uniform, so a single geometry in a single batch can wear different
// textures on different parts of itself. A tree's trunk vertices carry BARK
// while its canopy cards carry NEEDLES or LEAVES; one draw call, one material,
// no split. `src/props.js` already assigns layers this way per material group.
// Adding a species means adding a layer, not a material.
//
// THE ONE REAL CONSTRAINT: every layer in a DataArrayTexture must share
// dimensions and format. TEX_SIZE is therefore an invariant of the whole asset
// pipeline, not a knob -- see the note on it below.
//
// Layers come from two places. Procedural tiles (below) are placeholders that
// exist so the spike exercises the real path -- one sampler2DArray, alphaTest,
// mipmaps -- and are not meant to look good. Image layers are real PNGs loaded
// from `public/`, which is where the fern fronds and the baked prop layers live.
// ---------------------------------------------------------------------------

// INVARIANT, not a preference. A DataArrayTexture is one allocation of
// LAYER_COUNT identically-sized slices, so this is the slice format for every
// asset that will ever enter the array. 128 is what the pipeline already emits:
// all 40 layers in public/props/layers/ and all three fronds in public/ferns/
// are 128x128. Changing it means re-cutting every one of them.
export const TEX_SIZE = 128

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
  // Real scan, cut by tools/props/extract-frond.mjs.
  //
  // ONE, not the three the extractor produced. All three are the same Lady Fern
  // sheet: coverage 31.2/36.3/30.3%, mean RGB (28,41,4)/(28,40,4)/(29,44,1),
  // and side by side the only differences are that one is slightly gappier at
  // the top and another slightly blunter at the tip. On a card 0.38 as wide as
  // it is tall, at 128px, from two metres, that is nothing.
  //
  // THE RULE THIS SETS, because trees and grass are next: a layer has to earn
  // itself by reading as different AT THE DISTANCE IT WILL BE SEEN. Scan-to-scan
  // noise between two photographs of the same plant does not. Species-to-species
  // leaf shape does. So: one leaf layer per tree SPECIES, one shared bark, one
  // grass -- not three variants of each. The variety a player actually sees
  // comes from geometry (16 mesh variants x yaw x scale x per-frond jitter),
  // and geometry is where it should be bought.
  //
  // The cost of being wrong here is small in both directions: another layer is
  // 64 KB, no draw call and no per-frame cost, so if three fronds that genuinely
  // differ ever turn up, adding them back is a two-line change.
  FROND_0: 8,
}
export const LAYER_COUNT = 9

// Layers whose pixels come from a PNG rather than from a generator here.
// Relative URLs, because vite.config.js sets `base: './'`.
export const IMAGE_LAYERS = {
  [LAYER.FROND_0]: 'ferns/fern_frond_0.png',
}

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

  // DataArrayTexture wants one contiguous buffer, layers back to back. Image
  // layers are left at zero -- fully transparent, so alphaTest discards them --
  // until loadImageLayers() patches their bytes in.
  const data = new Uint8Array(n * n * 4 * LAYER_COUNT)
  for (let i = 0; i < LAYER_COUNT; i++) {
    if (layers[i]) data.set(layers[i], i * n * n * 4)
  }

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

// ---------------------------------------------------------------------------
// Real PNG layers.
//
// Called once at startup with the texture buildTextureArray() returned. The
// array is usable before this resolves -- image layers are transparent, so
// alphaTest discards them and a fern is simply invisible for the first frames
// rather than being a magenta rectangle.
//
// This is deliberately NOT tolerant. A layer that fails to load or arrives at
// the wrong size is a broken build, and the failure mode if we swallowed it is
// an invisible prop that nobody traces back to a 404 for a week. Throw.
// ---------------------------------------------------------------------------

async function decodeLayer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`texture layer ${url}: HTTP ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  if (bitmap.width !== TEX_SIZE || bitmap.height !== TEX_SIZE) {
    throw new Error(
      `texture layer ${url}: ${bitmap.width}x${bitmap.height}, but every layer ` +
        `of a DataArrayTexture must be ${TEX_SIZE}x${TEX_SIZE}`
    )
  }
  const canvas = new OffscreenCanvas(TEX_SIZE, TEX_SIZE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Uint8Array(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data.buffer)
}

/**
 * Patch every entry of IMAGE_LAYERS into `tex` in place. Loads in parallel and
 * uploads once, because each `needsUpdate` re-uploads the whole array and
 * regenerates every mip chain -- doing that per layer would cost LAYER_COUNT
 * times more than doing it once at the end.
 */
export async function loadImageLayers(tex, sources = IMAGE_LAYERS) {
  const entries = Object.entries(sources)
  const decoded = await Promise.all(entries.map(([, url]) => decodeLayer(url)))
  const stride = TEX_SIZE * TEX_SIZE * 4
  entries.forEach(([layer, url], i) => {
    tex.image.data.set(decoded[i], Number(layer) * stride)
  })
  tex.needsUpdate = true
  return entries.length
}
