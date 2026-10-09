import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../sim/mathx.js'
import { CLUMP_VARIANTS } from '../textures.js'
import { bakeImpostor, impostorCardExtents } from './impostor.js'
import { HEM_FRAY } from './tree-v8.js'
import { CARD_EXPOSURE } from './tree-bank.js'

// ---------------------------------------------------------------------------
// Forest clump cards: one photograph of SEVERAL trees standing together, for
// the clump tier of trees.js -- the card a thinned-out tree draws as so the
// trees the thinning cut around it are still in the picture.
//
// WHY. trees.js thins the forest as 1/d past its full-density ring, and a real
// forest does the opposite with distance: trees stack up in depth per pixel
// until the hillside reads solid. A card per tree cannot buy that back without
// the instances the thinning saved; a card that already has six trees in it
// can, and trees.js hands it to the same instance the single card was on.
//
// HOW. `composeTreeClump` plants CLUMP_TREES copies of one species' near tier
// in a shallow ellipse -- each at its own size, yaw and a little LIFT off the
// ground line -- PACKED, so the crowns overlap and the card is mostly tree
// rather than mostly the sky between trees, which is what makes its fill worth
// paying. `bakeTreeClumps` photographs CLUMP_VARIANTS such clumps per planted
// species, framed to the SAME extents, and returns the pixels: the pictures
// live in the shared litter card pool (litter-cards.js), where the instance
// picks its variant with its picture index. The lift makes the card's bottom
// edge ragged instead of a ruler line, which hides the card standing on
// ground that rises or falls across its footprint.
//
// A CLUMP IS A QUAD, NOT A TRIANGLE: six pines at six heights have a jagged
// top and a full-width base, and a triangle would clip the outer crowns.
// ---------------------------------------------------------------------------

export const CLUMP_TREES = 6

// Metres. The half-extents of the ellipse the trunks are scattered over --
// six slots 1.8 m apart against crowns 2 to 5 m wide, so the crowns overlap
// rather than stack, and shallow enough that the back row still shows between
// the front.
const SPREAD_X = 5.5
const SPREAD_Z = 2.5
// Size multipliers, the same range trees.js SCALE hands a placed tree.
const SIZE = [0.6, 1.3]
// Metres a trunk may stand above the card's ground line.
const LIFT_MAX = 1.5
// Seeds: variant i of planted species v composes from SEED_BASE + v * CLUMP_VARIANTS + i.
const SEED_BASE = 1000

/**
 * The subject extents every variant of one species is framed to, from the
 * species' near tier as the bank built it: the widest and tallest clump the
 * scatter law can compose, so the frame is a function of the species alone
 * and both variants share one quad. bakeTreeClumps throws if a composed clump
 * outgrows it.
 */
function clumpSubjectExtents(treeGeo) {
  const u = treeGeo.userData.tree
  if (!u) throw new Error('clumpSubjectExtents: the tree carries no userData.tree')
  return {
    width: 2 * SPREAD_X + u.crownWidth * SIZE[1],
    height: u.height * SIZE[1] + LIFT_MAX,
  }
}

/**
 * Plant `count` copies of `treeGeo` (a prop-layout tree geometry standing on
 * y = 0) as one merged geometry, centred on x and z so `bakeImpostor` frames
 * it. The caller owns the geometry.
 *
 * Trunks take evenly spaced slots across the ellipse, jittered, so no two
 * land on top of each other and the clump reads as six trees rather than one
 * fat one.
 */
export function composeTreeClump(treeGeo, { seed, count = CLUMP_TREES } = {}) {
  if (!(seed >= 0)) throw new Error(`composeTreeClump: needs a seed, got ${seed}`)
  if (!(count >= 2)) throw new Error(`composeTreeClump: a clump is at least two trees, got ${count}`)
  const rand = mulberry32(seed)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const parts = []
  const trees = []
  const slot = (SPREAD_X * 2) / count
  for (let i = 0; i < count; i++) {
    const x = -SPREAD_X + slot * (i + 0.5) + (rand() - 0.5) * slot * 0.8
    const z = (rand() * 2 - 1) * SPREAD_Z
    const y = rand() * LIFT_MAX
    const scale = SIZE[0] + rand() * (SIZE[1] - SIZE[0])
    const yaw = rand() * Math.PI * 2
    q.setFromAxisAngle(up, yaw)
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, scale, scale))
    const g = treeGeo.clone()
    g.applyMatrix4(m)
    parts.push(g)
    trees.push({ x, y, z, scale, yaw })
  }
  const geometry = mergeGeometries(parts, false)
  if (!geometry) throw new Error('composeTreeClump: the tree geometries did not merge (attribute mismatch)')
  for (const g of parts) g.dispose()
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  geometry.translate(-(bb.min.x + bb.max.x) / 2, 0, -(bb.min.z + bb.max.z) / 2)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return {
    geometry,
    width: bb.max.x - bb.min.x,
    height: bb.max.y,
    trees,
  }
}

/**
 * The clump card of each planted species in the prop layout, in `bank.variants`
 * order: `{ species, cardWidth, cardHeight }` metres, a quad standing on y = 0
 * and centred on x = 0, the frame every variant of the species is photographed
 * to. `bank` is `buildTreeBank()`'s.
 */
export function treeClumpCards(bank) {
  return bank.variants.map((v, i) => {
    const ext = impostorCardExtents(clumpSubjectExtents(bank.tiers[0].geometries[i]))
    return { species: v.species, cardWidth: ext.width, cardHeight: ext.height }
  })
}

/**
 * Photograph CLUMP_VARIANTS clumps per planted species, each framed to the
 * species' shared extents and lit at the single card's CARD_EXPOSURE, since it
 * stands in the same forest beside those cards. Call once, after
 * `loadImageLayers()` has resolved, beside bakeTreeImpostors. Returns one
 * record per photograph, species-major:
 * `{ species, variant, seed, pixels, width, height, coverage, meanLuma, trees }`,
 * `pixels` top row first as LitterCards.setPixels takes them.
 */
export function bakeTreeClumps(renderer, bank, { count = CLUMP_TREES } = {}) {
  const out = []
  bank.variants.forEach((v, vi) => {
    const treeGeo = bank.tiers[0].geometries[vi]
    const subject = clumpSubjectExtents(treeGeo)
    for (let i = 0; i < CLUMP_VARIANTS; i++) {
      const seed = SEED_BASE + vi * CLUMP_VARIANTS + i
      const clump = composeTreeClump(treeGeo, { seed, count })
      if (clump.width > subject.width || clump.height > subject.height) {
        throw new Error(`bakeTreeClumps: ${v.species} clump ${i} is ${clump.width.toFixed(2)}x${clump.height.toFixed(2)}, past its ${subject.width.toFixed(2)}x${subject.height.toFixed(2)} frame`)
      }
      const baked = bakeImpostor(renderer, clump.geometry, null, null, {
        ...subject,
        hemFray: HEM_FRAY,
        vertexColors: true,
        exposure: CARD_EXPOSURE,
      })
      clump.geometry.dispose()
      out.push({
        species: v.species, variant: i, seed, pixels: baked.pixels, width: baked.width, height: baked.height,
        coverage: baked.coverage, meanLuma: baked.meanLuma, trees: clump.trees,
      })
    }
  })
  return out
}
