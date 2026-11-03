// The ward runes' ten silhouettes (design/46-castle-wards.md), cut from the far cards the world already bakes: white where a card is
// opaque, clear elsewhere. A consumer tints them -- the runebook pages draw them black, the rune panel white.
import THREE from '../../three-instance.js'
import { LAYER, TEX_SIZE } from '../../textures.js'
import { ROCK_IMPOSTOR_LAYERS } from '../../props/rock-bank.js'
import { RUNES } from '../castles/wards.js'
import { CASTLE_CARD } from './castles.js'

export const RUNE_CELL = 128
const MARGIN = 8
const SOLID = 128

/** The texels (top row first, `size` square) of picture `i` of the litter pool. */
const pooled = (name, cards, i) => {
  if (!(i >= 0)) throw new Error(`rune atlas: ${name} has no far card in this room`)
  return { name, size: TEX_SIZE, px: cards.pixels(i) }
}

/** The ten sources in RUNES order -- `{ name, size, px }` -- off the room's layers; throws naming any whose card is not in this room. */
function sources({ litterCards, propTextures, frogs, crabs, wildlife, wildStriders, dragons, castles }) {
  const need = (layer, name) => { if (layer === null) throw new Error(`rune atlas: ${name} is not in this room`); return layer }
  const wild = (key) => {
    const sp = need(wildlife, key).species.find((s) => s.key === key)
    if (sp === undefined) throw new Error(`rune atlas: no ${key} in this room's wildlife`)
    return pooled(key, litterCards, sp.picture)
  }
  const layer = (name, l) => ({ name, size: TEX_SIZE, px: propTextures.image.data.subarray(l * TEX_SIZE * TEX_SIZE * 4, (l + 1) * TEX_SIZE * TEX_SIZE * 4) })
  const frog = () => {
    const f = need(frogs, 'frogs')
    if (!f.cardReady) throw new Error('rune atlas: the frog card has not been baked')
    return pooled('frog', litterCards, f.cardPicture)
  }
  const byRune = {
    strider: () => pooled('strider', litterCards, need(wildStriders, 'striders').inner.picture),
    crab: () => pooled('crab', litterCards, need(crabs, 'crabs').cardPicture),
    frog,
    rabbit: () => wild('hare'),
    deer: () => wild('stag'),
    fox: () => wild('fox'),
    dragon: () => pooled('dragon', litterCards, need(dragons, 'dragons').pictures[0]),
    pine: () => layer('pine', LAYER.IMPOSTOR_PINE),
    rock: () => layer('rock', ROCK_IMPOSTOR_LAYERS.boulder),
    castle: () => ({ name: 'castle', size: CASTLE_CARD.size, px: need(castles, 'castles').cardTexture.image.data }),
  }
  return RUNES.map((r) => byRune[r]())
}

/** One white-on-clear strip of RUNE_CELL cells, one per RUNES entry, each source cropped to its opaque bounds and fitted to its cell. Throws on a card still blank. */
export function buildRuneAtlas(world) {
  const strip = document.createElement('canvas')
  strip.width = RUNE_CELL * RUNES.length
  strip.height = RUNE_CELL
  const g = strip.getContext('2d')
  g.imageSmoothingQuality = 'high'
  sources(world).forEach(({ name, size, px }, k) => {
    const img = new ImageData(size, size)
    let x0 = size, y0 = size, x1 = -1, y1 = -1
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = px[(y * size + x) * 4 + 3], o = (y * size + x) * 4
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255
        img.data[o + 3] = a
        if (a >= SOLID) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
      }
    }
    if (x1 < 0) throw new Error(`rune atlas: the ${name} card is blank, not baked yet`)
    const src = document.createElement('canvas')
    src.width = src.height = size
    src.getContext('2d').putImageData(img, 0, 0)
    const w = x1 - x0 + 1, h = y1 - y0 + 1, s = (RUNE_CELL - 2 * MARGIN) / Math.max(w, h)
    g.drawImage(src, x0, y0, w, h, k * RUNE_CELL + (RUNE_CELL - w * s) / 2, (RUNE_CELL - h * s) / 2, w * s, h * s)
  })
  const texture = new THREE.CanvasTexture(strip)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
