import * as THREE from 'three'
import {
  tileLogs,
  tilePlanks,
  tileThatch,
  tileShingles,
  tileStone,
  tilePlaster,
  tileFringe,
  tileGlass,
  sheetIron,
  sheetRunes,
} from './buildings/tiles.js'

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

  // --- buildings (DESIGN.md §19) -------------------------------------------
  //
  // Nine layers for the whole Nordic kit, which is the number it takes to make
  // a building read as ONE object rather than as a pile of parts. The test each
  // of these passed is the one FROND_0 sets above -- a layer has to read as
  // different at the distance it will be seen -- and three candidates failed it
  // and are not here:
  //
  //   Slate roof. It is SHINGLE at a colder tint and a lower value. At 128 px
  //   from the 15 m a roof is normally seen at, the shake pattern is what you
  //   read and the hue is what tells you the material, and hue is free.
  //
  //   Chimney masonry. It is STONE. A chimney and a plinth are the same rubble
  //   laid by the same hands on the same building; if we later want dressed
  //   ashlar for a manor chimney that is a new layer for a new BUILDING class,
  //   not a second version of this one.
  //
  //   Moss on thatch. Not a texture at all -- it is a per-vertex colour
  //   multiply driven by roof height, normal and distance from the eave, which
  //   costs zero layers and zero triangles and varies per building for free.
  //   A moss layer would need a second blended pass over the roof, which means
  //   a second material, which splits the batch. That trade is never worth it.
  //
  // 10 building layers x 64 KB = 640 KB, taking the array from 9 to 19 of the
  // 256 layers §9 measured as available.
  TIMBER_HEWN: 9, // round log courses -- log-cabin walls, corner posts, purlins
  TIMBER_PLANK: 10, // sawn boards -- stave walls, doors, shutters, decking, gables
  THATCH: 11, // straw roof
  SHINGLE: 12, // wood shakes; tint cold for slate
  STONE: 13, // rubble masonry -- plinths, foundations, chimneys
  PLASTER: 14, // lime daub, the infill of a half-timbered panel
  THATCH_FRINGE: 15, // alpha-cut ragged eave edge; tiles in u, clamped in v
  GLASS: 16, // leaded panes, warped -- the one window material
  IRON: 17, // decal sheet: hinges, ring handles, nails, brackets
  RUNE: 18, // decal sheet: knotwork bands and carved staves

  // --- procedural trees (src/props/tree.js) ---------------------------------
  //
  // Appended rather than slotted in beside BARK and LEAVES, because a layer
  // index is a value baked into every `texLayer` attribute already in the
  // library -- renumbering is a silent re-skin of everything that ships.
  //
  // These three earn themselves under the FROND_0 rule above. Pine bark is
  // red-brown plates against oak's grey-green fissures, which is a hue AND a
  // pattern apart at any distance you can see a trunk from. Ash's paired
  // leaflets and aspen's round coins are different silhouettes, and silhouette
  // is the whole of what a leaf card is. What did NOT earn a layer: a separate
  // birch leaf (it wears LEAF_ASH), and any second bark for aspen (it wears
  // BARK_BIRCH -- both are pale and lenticelled, which is the botany).
  BARK_PINE: 19,
  LEAF_ASH: 20,
  LEAF_ASPEN: 21,
  // The TILING pine spray, for cloaked branches. Same art as NEEDLES but cut
  // with transparent side margin so it repeats along a branch without its
  // neighbours fusing; NEEDLES stays, cropped tight, because the scanned props
  // in src/props.js still address it as a single card.
  SPRAY_PINE: 22,
}
export const LAYER_COUNT = 23

// ---------------------------------------------------------------------------
// How many world METRES one [0,1] UV span of a tiling layer covers.
//
// This table is why buildings do not need per-face UV unwrapping. Every surface
// the parts kit emits takes its UVs straight from world-space extents divided
// by the entry here, so a 3.6 m log wall gets u from 0 to 4 and RepeatWrapping
// does the rest. Two consequences worth stating because they are the payoff:
//
//   Texel density is automatically constant. A cottage wall and an inn wall get
//   the same number of log courses per metre without anyone deciding, which is
//   the single thing that most makes a procedural kit look authored.
//
//   Nothing has to be re-UV'd when a mass is resized. The previewer's sliders
//   change extents freely and the texture simply covers more of the wall.
//
// The NUMBERS are art direction and belong to the previewer, not to a spec:
// they are the answer to "how big is one log", and they are meant to be tuned
// by eye against a 1.75 m door. Layers absent from this table are decal sheets,
// which are addressed by island and never scaled.
// ---------------------------------------------------------------------------
export const TILE_METRES = {
  [LAYER.TIMBER_HEWN]: 0.84, // 2 courses per tile -> a 0.42 m log
  [LAYER.TIMBER_PLANK]: 1.15, // 5 boards per tile -> a 0.23 m board
  [LAYER.THATCH]: 1.6, // 3 courses per tile
  [LAYER.SHINGLE]: 1.1, // 5 x 6 shakes per tile -> a 0.22 x 0.18 m shake
  [LAYER.STONE]: 1.3, // 4 courses of 4 -> a 0.33 x 0.33 m stone
  [LAYER.PLASTER]: 2.2, // deliberately large; the panel should read as flat
  [LAYER.THATCH_FRINGE]: 1.6, // matches THATCH so straws line up across the eave
  [LAYER.GLASS]: 0.46, // 2 x 2 panes per tile -> a 0.23 m quarry
}

// Layers whose pixels come from a PNG rather than from a generator here.
// Relative URLs, because vite.config.js sets `base: './'`.
//
// The tree layers are cut from EZ-Tree's art by `tools/trees/gen-layers.mjs`.
// The two thatch layers are cut from the thatch photograph by
// `tools/props/extract-thatch.mjs` (DESIGN.md §19).
//
// Note that BARK, BARK_BIRCH, NEEDLES, LEAVES, THATCH and THATCH_FRINGE ALSO
// have procedural generators below and are filled by them first:
// `loadImageLayers` patches over that a few frames later, so a trunk is
// placeholder bark for an instant rather than invisible. Do not delete those
// generators thinking they are dead.
export const IMAGE_LAYERS = {
  [LAYER.FROND_0]: 'ferns/fern_frond_0.png',
  [LAYER.THATCH]: 'buildings/thatch.png',
  [LAYER.THATCH_FRINGE]: 'buildings/thatch_fringe.png',
  [LAYER.BARK]: 'trees/bark_oak.png',
  [LAYER.BARK_BIRCH]: 'trees/bark_birch.png',
  [LAYER.BARK_PINE]: 'trees/bark_pine.png',
  [LAYER.NEEDLES]: 'trees/leaf_pine.png',
  [LAYER.LEAVES]: 'trees/leaf_oak.png',
  [LAYER.LEAF_ASH]: 'trees/leaf_ash.png',
  [LAYER.LEAF_ASPEN]: 'trees/leaf_aspen.png',
  [LAYER.SPRAY_PINE]: 'trees/spray_pine.png',
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
  // The three tree layers added for src/props/tree.js. Same job as the four
  // above: stand in for the PNG for the few frames before loadImageLayers()
  // lands, tinted to roughly where the real art sits so the swap is not a
  // flash of a different colour. LEAF_ASPEN is yellow because EZ-Tree's aspen
  // atlas is in autumn.
  layers[LAYER.BARK_PINE] = bark([84, 46, 30], [132, 84, 56], 19)
  layers[LAYER.LEAF_ASH] = foliage([44, 76, 34], [96, 132, 58], 20, true)
  layers[LAYER.LEAF_ASPEN] = foliage([146, 108, 26], [214, 172, 52], 21, true)
  layers[LAYER.SPRAY_PINE] = foliage([28, 56, 34], [52, 88, 51], 22, true)
  layers[LAYER.ROCK] = mottled([92, 92, 96], [138, 137, 132], 7, 15)
  layers[LAYER.SNOW] = mottled([222, 230, 240], [255, 255, 255], 5, 16)
  layers[LAYER.DIRT] = mottled([94, 76, 58], [126, 106, 82], 9, 17)
  layers[LAYER.GRASS] = foliage([58, 92, 44], [96, 130, 62], 18, false)

  // Building layers. These live in src/buildings/tiles.js rather than here
  // because they are ten times the code of the four generators above and this
  // file's job is to be the layer REGISTRY -- the thing you read to find out
  // what a texLayer value means. Which of them are provisional and which are
  // shipping art is argued there.
  layers[LAYER.TIMBER_HEWN] = tileLogs(n)
  layers[LAYER.TIMBER_PLANK] = tilePlanks(n)
  layers[LAYER.THATCH] = tileThatch(n)
  layers[LAYER.SHINGLE] = tileShingles(n)
  layers[LAYER.STONE] = tileStone(n)
  layers[LAYER.PLASTER] = tilePlaster(n)
  layers[LAYER.THATCH_FRINGE] = tileFringe(n)
  layers[LAYER.GLASS] = tileGlass(n)
  layers[LAYER.IRON] = sheetIron(n)
  layers[LAYER.RUNE] = sheetRunes(n)

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
