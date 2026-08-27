// Node-side gates for the forest (src/props/tree.js, src/props/tree-bank.js,
// src/v2/render/trees.js, DESIGN.md §5).
//
//   node scripts/check-trees.mjs
//
// A tree is the only prop in the world that the player sees at every range at
// once -- one at 8 m with its bark readable, three hundred at 60 m, forty
// thousand out to the horizon -- so almost everything below is a failure that
// is invisible in a screenshot of one tree and ruinous across a hillside of
// them. In the order they cost the most:
//
//   THE COARSE MESH STOPS BEING THE SAME TREE. treeLod(p, 1) is the tier the
//   world draws between 8 and 15 m, and it is LOD0 with cheaper WOOD and nothing
//   else: a 3-sided trunk, one fin per limb, the same card per spray. Two
//   parameters move and no count does, so buildTree walks an identical rng
//   stream and lays out an identical tree, which is what makes the swap at 8 m
//   invisible. The moment a count moves, the crown moves with it: the note this
//   replaced records a bundled coarse crown coming out 45% wider than its LOD0
//   one on aspen, which reads as every distant tree inflating as you walk away
//   from it. Nothing throws. So the two are compared VERTEX BY VERTEX here
//   rather than argued from the parameters.
//
//   THE TRIANGLE LAW DRIFTS AWAY FROM THE BUILDER. resolveTree is the one place
//   the law lives, the previewer's budget panel prints it, and the bank sizes
//   itself from it -- so if it disagrees with what buildTree actually emits, the
//   forest costs a different number of triangles than every report about it
//   says. The law is re-derived here from its own docblock and checked against
//   the INDEX COUNT of the built geometry, for every species, at LOD0 and at the
//   coarse mesh alike.
//
//   THE PASTED-IN ART MEASUREMENTS DRIFT AWAY FROM THE ART. `sprayStemU` and
//   `sprayStemV` are where a leaf cut grows from, measured off the shipped PNG
//   and typed into the species table, and they are what puts a card's stem on
//   its twig. Re-cut the art and they still describe the old cut: every spray in
//   the forest hangs a few centimetres off its own branch, nothing throws, and
//   one tree up close looks fine. So they are re-derived from public/trees/*.png
//   at the alpha test's own threshold rather than trusted.
//
//   THE CROWN'S PROPORTIONS STOP BEING PROPORTIONS. Three rules that are
//   arithmetic on the parameters and hold at every seed -- a branch is never
//   fatter than the trunk it leaves (`branchOfTrunk`), a terminal spray seats on
//   wood with a radius rather than on the point of a cone (`sprayTipBack`), and
//   the leader cards are smaller than the crown under them (`apexScale`). Each
//   was a visible wrongness before its knob existed, and each would come back
//   silently, so the branch plan is walked here the way buildTree walks it and
//   the count of branches the cap BITES on is gated -- a walk that has drifted
//   from the generator finds a cap that is satisfied on a tree nobody builds.
//
//   THE THINNING LAW STOPS HOLDING. FULL_RADIUS / d is what buys the 1.5 km
//   horizon: it makes the instance count linear in the radius instead of
//   quadratic, ~37k instead of ~353k. It is spread across a quantised level
//   table, a per-tile nearest-corner distance and a per-candidate rank, and any
//   of the three drifting gives a forest that is merely thinner or merely more
//   expensive, neither of which reads as wrong. So it is measured on the placed
//   instances, and separately on the DRAWN ones -- the tile quantisation
//   deliberately over-keeps and the per-instance rim dissolve is what puts the
//   density back, so only the second of those two populations follows the law.
//
//   THE FAR CARD QUIETLY GOES BACK TO BEING A QUAD. The last tier holds tens of
//   thousands of instances, so it IS the forest's triangle bill, and a variant
//   that reaches buildImpostorCard without a `billboardTri` falls back to a quad
//   and doubles that bill without anything looking wrong. The one triangle also
//   carries three contracts a quad does not: uvs strictly inside the unit square
//   (the array is RepeatWrapping), a footprint symmetric about u = 0.5 (because
//   billboardVertex mirrors u per instance), and an exactly vertical normal,
//   which is the whole of what tells the shader to spin it. All four are checked
//   on the built geometry rather than on the species table.
//
//   THE LADDER STOPS BEING THE SHAPE BOTH FILES THINK IT IS. tree-bank.js
//   decides how many tiers there are and trees.js LOD_BANDS decides where their
//   boundaries sit, and neither file imports the other. LOD_BANDS has to have
//   exactly one entry per tier boundary: one too few and the last tier is
//   unreachable -- the coarsest and by far the most numerous tier in the forest
//   simply never draws -- one too many and update() indexes past the ladder. So
//   the tier count, the band count and each tier's triangle cost are all pinned
//   here. Same shape of check as the grass's, and the same silent failure.
//
//   Y_SQUASH STOPS BEING A SQUASH. The bands are ellipsoids because instY is the
//   tree's ROOT and the tree is not: without it a player on a ledge 9 m above a
//   stand looks down at billboards. It has to be a strict promotion -- it may
//   never push an instance to a coarser tier than a plain sphere would -- and it
//   has to be nearly inert at eye height, or it silently widens every band and
//   the near count with it.
//
//   THE ATTRIBUTE LAYOUT DRIFTS. BatchedMesh validates that every geometry in
//   the batch has an identical layout and refuses the whole mesh over one stray
//   `uv`, so this is a boot failure for the entire forest.

import { readFileSync } from 'node:fs'

import * as THREE from 'three'

import {
  TREE_DEFAULTS, TREE_SPECIES, treeLod, resolveTree, buildTree, crownProfile,
} from '../src/props/tree.js'
import { TREE_SIZES, buildTreeBank, treeVariants, treeImpostorLayers } from '../src/props/tree-bank.js'
import { buildImpostorCard } from '../src/props/impostor.js'
import { CARD_UP_MARK, PROP_FADE_SECONDS } from '../src/material.js'
import { Trees, TREE_TUNING } from '../src/v2/render/trees.js'
import { GRASS_TUNING } from '../src/v2/render/grass.js'
import { LAYER_COUNT, IMAGE_LAYERS, buildTextureArray } from '../src/textures.js'
import { readPng } from '../tools/props/png.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const note = (label, detail = '') => {
  console.log(` note  ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol
const pct = (v) => `${(v * 100).toFixed(2)}%`

const { DENSITY, FULL_RADIUS, DRAW_RADIUS, LOD_BANDS, LOD_HYSTERESIS, Y_SQUASH,
  TILE, QUANT, NEAR_MARGIN, PLACEMENT, PLACEMENT_CELL } = TREE_TUNING

const species = Object.keys(TREE_SPECIES)

// The bank's own paramsFor, and it has to stay the bank's: leafLayer, barkLayer
// and impostorLayer live at the TOP of a species entry rather than inside its
// `.params`, so spreading only `.params` silently builds every species with
// TREE_DEFAULTS.leafLayer and the foliage comparison below finds nothing to
// compare.
const paramsFor = (s, seed, size = 1) => {
  const sp = TREE_SPECIES[s]
  const base = { ...TREE_DEFAULTS, ...sp.params }
  return {
    ...base,
    leafLayer: sp.leafLayer,
    barkLayer: sp.barkLayer,
    height: base.height * size,
    seed,
  }
}

// WHAT EVERY PROBE BELOW IS CHECKED AGAINST BEFORE IT IS BELIEVED. The failure
// paramsFor's note describes does not throw: a harness that spread `sp` instead
// of `sp.params` builds four copies of the DEFAULT tree, and every number it
// then prints is a plausible measurement of the wrong plant, sitting comfortably
// inside whatever tolerance was written for the right one. These are the
// triangle counts pine, oak, birch and aspen actually build at seed 7 and their
// own heights, so a harness that has stopped measuring the species says so here
// rather than passing three sections later.
const LOD0_TRIS = { pine: 819, oak: 543, birch: 377, aspen: 459 }

// --- 1. the triangle law ----------------------------------------------------
//
// Re-derived from resolveTree's docblock rather than imported from it, so this
// gates the LAW and not resolveTree's arithmetic against itself. Both are then
// checked against the built mesh, which is the only number the GPU ever sees.

console.log('\n-- the triangle law --')

{
  const cone = (n, r) => (n >= 3 ? n * ((Math.max(1, Math.round(r)) - 1) * 2 + 1) : 0)
  const limb = (n, r) => (Math.round(n) === 1 ? 1 : cone(Math.round(n), r))
  const lawTris = (p, r) => {
    const trunk = p.trunkRadius > 0 ? cone(Math.max(3, Math.round(p.trunkSides)), p.trunkRings) : 0
    // A spur is a fixed two-face wedge, not a cone -- its underside is never
    // drawn, so no `cone` term applies. LOD0 only: treeLod sets `roots` to 0, so
    // this is the whole of what the coarse tier DELETES rather than draws
    // cheaper.
    const root = p.trunkRadius > 0 && p.rootWidth > 0
      ? Math.max(0, Math.round(p.roots)) * 2
      : 0
    const branch = r.limbs * limb(p.branchSides, p.branchRings)
    const foliage = r.bundleTris > 0
      ? r.bundleTris
      : (r.limbs * r.sprays + r.apexSprays) * r.cardTris
    return trunk + root + branch + foliage
  }

  for (const s of species) {
    const p0 = paramsFor(s, 7)
    const p1 = treeLod(p0, 1)
    const r0 = resolveTree(p0)
    const r1 = resolveTree(p1)
    const g0 = buildTree(p0)
    const g1 = buildTree(p1)
    const a0 = g0.index.count / 3
    const a1 = g1.index.count / 3

    check(a0 === LOD0_TRIS[s],
      `${s} still builds the ${LOD0_TRIS[s]} LOD0 triangles every probe here is measured at`,
      `built ${a0} at seed 7 and ${p0.height} m`)
    check(r0.bundleTris === 0, `${s} LOD0 draws its crown as one card per spray`,
      `bundleTris ${r0.bundleTris}, ${r0.sprayTris} card triangles`)
    check(r1.bundleTris === 0 && r1.sprayTris === r0.sprayTris,
      `${s} LOD1 draws the same card per spray LOD0 does`,
      `bundleTris ${r1.bundleTris}, ${r1.sprayTris} card triangles against LOD0's ${r0.sprayTris}`)
    check(lawTris(p0, r0) === r0.triangles && r0.triangles === a0,
      `${s} LOD0 builds exactly the triangles the law predicts`,
      `law ${lawTris(p0, r0)}, resolveTree ${r0.triangles}, built ${a0}`)
    check(lawTris(p1, r1) === r1.triangles && r1.triangles === a1,
      `${s} LOD1 builds exactly the triangles the law predicts`,
      `law ${lawTris(p1, r1)}, resolveTree ${r1.triangles}, built ${a1}`)
    // The shape of the LOD1 bill, spelled out: a 3-sided trunk, one fin per
    // limb, and the crown LOD0 draws, untouched. The whole saving is wood, and
    // that is deliberate -- the cards are the tree's silhouette at 8 to 15 m and
    // there is no cheaper way to draw them that is still the same plant.
    check(r1.triangles === r1.trunkTris + r1.limbs + r1.sprayTris
      && r1.trunkTris === 3 && r1.sprayTris === r0.sprayTris && r1.rootTris === 0,
      `${s} LOD1 costs trunk 3 + one fin per limb + LOD0's own crown, and no roots`,
      `3 + ${r1.limbs} + ${r1.sprayTris} = ${r1.triangles}, roots ${r1.rootTris}`)
    // The root crown, which only LOD0 has: a flare the player stands next to,
    // gone by the 8 m where the coarse tier takes over. Gated as a real cost
    // rather than a free one -- 10 triangles is 1.2% of a pine and 2.8% of a
    // birch, and it is the only part of the tree that is mostly under the soil.
    check(r0.rootTris > 0 && r0.rootTris === r0.roots * 2 && a0 - a1 > r0.rootTris,
      `${s} grows a LOD0-only root crown for ${r0.rootTris} triangles`,
      `${r0.roots} spurs x 2, the wedge's two flanks with no underside`)
    // A wood-only saving is a MODEST saving, and the band is set from what the
    // bank actually measures: 1.22x on a big oak, which carries few fat limbs,
    // to 1.58x on a sapling, whose trunk is most of its bill. A ratio under 1.15
    // is a tier not worth its own draw; over 1.75 is foliage that has started
    // going missing, which is the failure this pairs with the foliage check
    // above to catch.
    check(a0 / a1 > 1.15 && a0 / a1 < 1.75, `${s} LOD1 is between 1.15x and 1.75x cheaper than LOD0`,
      `${a0} -> ${a1}, ${(a0 / a1).toFixed(2)}x`)

    // Same number at both levels, and here that is not merely by construction:
    // the two tiers draw the same cards, so a spray that changed size between
    // them would be the same leaf growing as the player walks towards it.
    check(r0.sprayMetres === r1.sprayMetres, `${s} asks for the same spray size at LOD0 and LOD1`,
      `${r0.sprayMetres} m, built ${g0.userData.tree.sprayMetres.toFixed(4)} / ` +
      `${g1.userData.tree.sprayMetres.toFixed(4)} m after the rescale`)

    g0.dispose()
    g1.dispose()
  }
}

// --- 1b. the trunk is not a pole --------------------------------------------
//
// `trunkLobe` exists so a trunk you walk up to is not a lathe-turned cone. What
// has to be true of it: the base ring is genuinely out of round, by about the
// amplitude asked for and not more; NO TWO TREES ARE OUT OF ROUND THE SAME WAY,
// which is the whole point and is what a single hardcoded profile would fail;
// and the lobes are SMOOTH around the ring rather than aliased into spikes,
// which is the failure a harmonic above the sampling rate produces and is the
// one that would read as a modelling bug rather than as wood.

console.log('\n-- the trunk is not a pole --')

{
  // The trunk cone is built first and its base ring is the first `sides + 1`
  // vertices, the last of which is the duplicated seam. Reading them directly is
  // the only way to see the built skin rather than the parameter.
  const baseRing = (p) => {
    const g = buildTree(p)
    const pos = g.attributes.position.array
    const sides = Math.max(3, Math.round(p.trunkSides))
    const r = []
    for (let k = 0; k < sides; k++) r.push(Math.hypot(pos[k * 3], pos[k * 3 + 2]))
    g.dispose()
    return r
  }
  const spread = (r) => {
    const mean = r.reduce((a, b) => a + b, 0) / r.length
    return { mean, lo: Math.min(...r) / mean, hi: Math.max(...r) / mean }
  }

  for (const s of species) {
    const p = paramsFor(s, 7)
    const r = baseRing(p)
    const sp = spread(r)
    check(sp.hi - sp.lo > 0.12 && sp.hi - sp.lo < 2.2 * p.trunkLobe,
      `${s}'s trunk is out of round, by about what trunkLobe asked for`,
      `x${sp.lo.toFixed(3)} to x${sp.hi.toFixed(3)} of the mean, at trunkLobe ${p.trunkLobe}`)

    // THE ALIASING TEST IS A COUNT OF TURNS, not a step size. A profile of
    // harmonics up to `top` turns from swelling to hollowing 2 x top times
    // around the ring and no more, whatever its amplitude; one aliased past the
    // sampling rate turns at nearly every corner, because that is what "the
    // ring cannot represent this harmonic" looks like in the vertices. The step
    // size cannot separate those on its own -- 2*pi*n*A/sides is already ~15% of
    // the radius for the FUNDAMENTAL at this amplitude, which is a real slope
    // and what a swollen trunk should have -- so it is here only as the upper
    // bound an alternating in-out ring would blow through.
    const top = Math.max(2, Math.floor(r.length / 3))
    let turns = 0
    let worst = 0
    for (let k = 0; k < r.length; k++) {
      const d0 = r[(k + 1) % r.length] - r[k]
      const d1 = r[(k + 2) % r.length] - r[(k + 1) % r.length]
      if (d0 * d1 < 0) turns++
      worst = Math.max(worst, Math.abs(d0) / sp.mean)
    }
    check(turns <= 2 * top && worst < 1.3 * p.trunkLobe,
      `${s}'s lobes are a smooth profile rather than a ring aliased into spikes`,
      `${turns} turns around ${r.length} corners (a profile capped at harmonic ${top} may have ${2 * top}), worst step ${(worst * 100).toFixed(1)}% of the radius`)
  }

  // Two trees, same species, different seed. Identical rings would mean the
  // profile is a constant dressed up as a draw.
  const a = baseRing(paramsFor('oak', 7))
  const b = baseRing(paramsFor('oak', 11))
  let same = 0
  for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) < 1e-4) same++
  check(same < a.length / 3, 'two oaks at two seeds are out of round differently',
    `${same} of ${a.length} corners agree to 0.1 mm`)

  // And the coarse tier, whose 3-sided trunk cannot carry a lobe without
  // turning into a spike. `sides >= 6` in buildTree is what stops it; if that
  // guard goes, this ring comes back wildly uneven.
  const coarse = baseRing(treeLod(paramsFor('oak', 7), 1))
  const cs = spread(coarse)
  check(cs.hi - cs.lo < 1e-6, 'and LOD1\'s three-sided trunk is left perfectly round',
    `x${cs.lo.toFixed(4)} to x${cs.hi.toFixed(4)}`)
}

// --- 2. the coarse mesh nests inside LOD0 -----------------------------------
//
// The strong form of the nesting claim tree-bank.js's header makes about the two
// mesh tiers, and the reason the 8 m swap is not a pop: LOD1 must be the SAME
// TREE as LOD0 -- not a similar one, not one within a tolerance -- because
// treeLod moves nothing that feeds the layout and buildTree is deterministic in
// its seed. Foliage only: the trunk and branches legitimately differ, since that
// is the whole of what the level changes.
//
// Positions are divided by userData.tree.height before they are compared. The
// rescale loop drives both builds to the requested height so the ratio is 1 in
// practice, but a build that quietly came out at a different size would show up
// as a shape difference rather than as an offset, which is the harder failure
// to see.

console.log('\n-- the coarse mesh nests inside LOD0 --')

{
  const foliage = (geo, leafLayer) => {
    const pos = geo.attributes.position
    const layer = geo.attributes.texLayer
    const h = geo.userData.tree.height
    const out = []
    for (let i = 0; i < pos.count; i++) {
      if (layer.getX(i) !== leafLayer) continue
      out.push(pos.getX(i) / h, pos.getY(i) / h, pos.getZ(i) / h)
    }
    return out
  }

  for (const s of species) {
    let counts = true
    let worst = 0
    let verts = 0
    for (let k = 0; k < 8; k++) {
      const p = paramsFor(s, 1 + k * 101)
      const g0 = buildTree(p)
      // Nothing to undo: treeLod makes no foliage change at all, so what is
      // left is the trunk and branch coarsening, which cannot touch a leaf.
      const g1 = buildTree(treeLod(p, 1))
      const a = foliage(g0, p.leafLayer)
      const b = foliage(g1, p.leafLayer)
      verts = a.length / 3
      if (a.length !== b.length) { counts = false; break }
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      g0.dispose()
      g1.dispose()
    }
    check(counts && verts > 0 && worst === 0,
      `${s} lays out an identical crown at LOD0 and at LOD1, over 8 seeds`,
      `${verts} foliage vertices, worst drift ${worst.toExponential(1)} of a tree height`)
  }
}

// --- 3. crown and height parity ---------------------------------------------
//
// What the nesting buys, measured as a size rather than as a vertex list. LOD1
// has to be the same tree WIDE and TALL as LOD0, because the bank frames every
// tier on tier 0's crownWidth and tier 0's height and never measures the others,
// and a swap that changes a tree's size is the one an eye catches instantly.
//
// BOTH ARE GATED AS EXACT, and that is a stronger promise than it looks. Height
// is exact because the same rescale loop drives both builds to the requested
// metre. Width is exact because the crown is not resampled at this tier -- it is
// the identical card list, so its bounding box is the identical box. This is
// what the tier that was withdrawn could not do: a bundled crown SAMPLES the
// sprays (60 corners against hundreds of cards), so it came out 1% narrow on
// oak, 6% narrow on pine, and needed a 4-to-8% tolerance and a paragraph
// defending it. Zero needs neither. If either number ever comes off zero, some
// count has started moving inside treeLod and the rng streams have parted.

console.log('\n-- crown and height parity --')

for (const s of species) {
  const d = []
  let worstHeight = 0
  for (const size of TREE_SIZES) {
    for (let k = 0; k < 16; k++) {
      const p = paramsFor(s, 3 + k * 101, size)
      const g0 = buildTree(p)
      const g1 = buildTree(treeLod(p, 1))
      d.push(g1.userData.tree.crownWidth / g0.userData.tree.crownWidth - 1)
      worstHeight = Math.max(worstHeight,
        Math.abs(g1.userData.tree.height / g0.userData.tree.height - 1))
      g0.dispose()
      g1.dispose()
    }
  }
  const worstWidth = d.reduce((a, b) => Math.max(a, Math.abs(b)), 0)
  check(worstWidth === 0, `${s} LOD1 crowns are exactly as wide as LOD0's`,
    `worst ${pct(worstWidth)} over ${d.length} builds`)
  check(worstHeight === 0, `${s} stands exactly as tall at LOD1 as at LOD0`,
    `worst ${pct(worstHeight)} over ${d.length} builds`)
}

// --- 4. the stem numbers match the art they were measured from --------------
//
// `sprayStemU` and `sprayStemV` say where in a leaf cut the spray actually grows
// from, and they are the whole of what hangs a card on its twig rather than a
// few centimetres off to one side of it and above it -- the long version is at
// sprayStemU in tree.js. They are MEASURED off the shipped PNGs and pasted into
// the species table, which makes them the one kind of number that goes wrong
// without anything going wrong: re-cut the art and the params still describe the
// old cut, and every spray on every tree in the forest slides off its branch by
// however far the stem moved. Nothing throws, nothing looks broken up close, and
// a hillside reads as slightly loose.
//
// So they are re-derived here from public/trees/*.png and compared with what
// tree.js ships. Each half of the derivation, and why it is that and not the
// obvious alternative:
//
//   THRESHOLD 128, because the prop material's alphaTest is 0.5 and a texel the
//     alpha test discards is not part of the art. That is most of the reason ash
//     lands as far up as v 0.203: its bottom fifth is a stalk two texels wide,
//     which is opaque and is nowhere near a tenth of a full row.
//   ROW 0 IS v = 0, AND IT IS THE STEM END, because textures.js writes file rows
//     straight into the layer with no flip. Reading the image the other way up
//     yields four perfectly plausible numbers measured off the TIP of each cut.
//   stemV is the first row (from the stem up) carrying a tenth of the widest
//     row: where the cut stops being a stalk and starts being a spray.
//   stemU is the opaque-count-weighted mean u of the rows BELOW the first one
//     carrying a quarter of the widest -- the stalk and the first leaves, which
//     is the part that has to meet the wood. Weighting the whole cut instead
//     would measure where the spray's mass ended up, which is a different
//     question and would move with a leaf on one side.

console.log('\n-- the stem numbers match the art --')

{
  // Rows of the cut, at the alpha test's own threshold: how many texels each row
  // keeps and where across the card they sit.
  const stemOf = (file) => {
    const png = readPng(new URL(`../public/${file}`, import.meta.url).pathname)
    if (png.channels !== 4) throw new Error(`${file}: ${png.channels} channels, expected RGBA`)
    const { width, height, data } = png
    const n = new Array(height).fill(0)
    const meanU = new Array(height).fill(0)
    for (let y = 0; y < height; y++) {
      let opaque = 0
      let sumU = 0
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 128) continue
        opaque++
        sumU += (x + 0.5) / width
      }
      n[y] = opaque
      meanU[y] = opaque > 0 ? sumU / opaque : 0
    }
    const max = Math.max(...n)
    let v = 0
    for (let y = 0; y < height; y++) if (n[y] >= 0.10 * max) { v = y / height; break }
    let body = height
    for (let y = 0; y < height; y++) if (n[y] >= 0.25 * max) { body = y; break }
    let weighted = 0
    let weight = 0
    for (let y = 0; y < body; y++) { weighted += meanU[y] * n[y]; weight += n[y] }
    return { u: weight > 0 ? weighted / weight : 0.5, v, width, height, max, body }
  }

  for (const s of species) {
    const p = paramsFor(s, 7)
    const file = IMAGE_LAYERS[p.leafLayer]
    check(!!file, `${s} hangs its foliage on a layer that comes from a PNG`, `layer ${p.leafLayer}`)
    const m = stemOf(file)
    check(near(m.u, p.sprayStemU, 0.02) && near(m.v, p.sprayStemV, 0.02),
      `${s} ships the stem the art has, within 0.02 of both`,
      `${file} ${m.width}x${m.height}: art u ${m.u.toFixed(3)} v ${m.v.toFixed(3)}, ` +
      `param u ${p.sprayStemU} v ${p.sprayStemV}, widest row ${m.max} texels, ` +
      `body from row ${m.body}`)
  }
}

// --- 5. the crown's proportions ---------------------------------------------
//
// Three shape rules that hold at every seed and every size because they are
// arithmetic on the parameters rather than anything the rng touches, and three
// failures that are invisible in a screenshot of one tree.
//
//   A BRANCH THICKER THAN ITS TRUNK. `branchWidth` sizes a limb off its own
//     length, which is the right instinct and the wrong shape: the trunk is a
//     cone closing to a point while `crownProfile` puts the LONGEST branches
//     around the middle, so the two curves cross. `branchOfTrunk` is the cap,
//     and the count of branches it BITES on is the number with teeth here -- if
//     the plan walk below drifts away from buildTree's, the cap still looks
//     satisfied while measuring a tree nobody builds. Those counts are tree.js's
//     own, recorded at branchOfTrunk before the cap went in.
//   A TERMINAL SPRAY ON A POINT. `sprayTipBack` seats the end card short of the
//     tip because the apex of a cone has no radius, and a card hung there has
//     nothing but a point to touch and reads as floating in front of the branch.
//     What matters is that the wood it backs up to has a real radius on the
//     thinnest species too, not just on a pine.
//   A LEADER SHOOT THAT DWARFS THE CROWN. The apex cards are the only ones that
//     skip `sprayTaper`, so at `apexScale` 1 they come out full size against
//     limb tips already cut to a third of it -- on a pine roughly three times
//     its tips, which is the case that put the knob there.
//
// The plan walk is buildTree's, with the ONE substitution its own comment allows:
// a scattered crown (whorlSize 0) draws its height from the rng, and the
// half-step of the even cases is used instead so this is a statement about the
// species rather than about seed 7. Pine is the only species that scatters, and
// the profile is smooth in t, so the bite count is the same either way.

console.log('\n-- the crown\'s proportions --')

// tree.js's branchOfTrunk note, which recorded what each species did BEFORE the
// cap existed. A different number here means this walk and buildTree's have
// parted company -- fix the walk, not the number.
const CAP_BITES = { pine: 3, oak: 6, birch: 11, aspen: 11 }

{
  const branchPlan = (p) => {
    const R = resolveTree(p)
    const n = R.branches
    const whorl = Math.max(0, Math.round(p.whorlSize))
    const whorls = Math.max(1, Math.ceil(n / Math.max(1, whorl)))
    const plan = []
    for (let i = 0; i < n; i++) {
      const wi = Math.floor(i / Math.max(1, whorl))
      const t = whorl > 1 ? (wi + 0.5) / whorls : (i + 0.5) / n
      const f = p.firstBranch + t * (1 - p.firstBranch)
      const prof = crownProfile(t, p.crownPeak, p.crownFullness)
      const length = p.branchLength * (p.branchMin + (1 - p.branchMin) * prof)
      // Sized off its own length, capped at its share of the trunk radius where
      // it leaves it -- buildTree's own line, and `radiusAt` is linear to zero.
      const own = length * p.branchWidth
      const cap = p.trunkRadius * (1 - f) * p.branchOfTrunk
      plan.push({ t, f, length, own, cap, baseRadius: Math.min(own, cap) })
    }
    return plan
  }

  check(TREE_DEFAULTS.sprayTipBack > 0 && TREE_DEFAULTS.sprayTipBack < 1,
    'a terminal card is seated short of the tip and still on its own limb',
    `sprayTipBack ${TREE_DEFAULTS.sprayTipBack}`)

  for (const s of species) {
    const p = paramsFor(s, 7)
    const plan = branchPlan(p)
    const over = plan.filter((b) => b.baseRadius > b.cap + 1e-12).length
    const bites = plan.filter((b) => b.own > b.cap).length

    check(over === 0, `${s} grows no branch thicker than its share of the trunk it leaves`,
      `${plan.length} branches, ${over} over ${p.branchOfTrunk} of the trunk radius at their own height`)
    check(bites === CAP_BITES[s],
      `${s} has the cap bite on the ${CAP_BITES[s]} of ${plan.length} branches tree.js measured`,
      `${bites}/${plan.length} sized off their own length would be fatter than the wood`)

    // The longest branch is the one carrying the most foliage and the one whose
    // terminal card is furthest from anything else, so it is where a spray
    // hanging off a point would show first.
    const longest = plan.reduce((m, b) => (b.length > m.length ? b : m), plan[0])
    const seatMm = longest.baseRadius * p.sprayTipBack * p.height * 1000
    check(seatMm > 5, `${s} seats its terminal spray on wood at least 5 mm thick`,
      `longest branch ${(longest.length * p.height).toFixed(2)} m, ` +
      `base radius ${(longest.baseRadius * p.height * 1000).toFixed(1)} mm, ` +
      `${seatMm.toFixed(1)} mm at the seat ${p.sprayTipBack} back from the tip`)

    // The apex cards skip the taper, so the size to beat is a limb spray at
    // grade 1 -- its size where the limb leaves the trunk, which is the biggest
    // card the crown carries.
    const R = resolveTree(p)
    const apex = R.sprayMetres * p.apexScale
    const atBase = R.sprayMetres
    const atTip = R.sprayMetres * p.sprayTaper
    check(p.apexScale < 1 && apex < atBase,
      `${s} gives its leader cards less reach than the biggest spray under them`,
      `apexScale ${p.apexScale}: ${apex.toFixed(2)} m against ${atBase.toFixed(2)} m at a limb's base ` +
      `and ${atTip.toFixed(2)} m at its tip, so ${(apex / atTip).toFixed(2)}x a tip ` +
      `where full size was ${(atBase / atTip).toFixed(2)}x`)
  }
}

// --- 6. the bank ------------------------------------------------------------

console.log('\n-- bank --')

const bank = buildTreeBank({ seed: 1, billboard: true })
const variants = treeVariants()

{
  check(bank.variants.length === species.length * TREE_SIZES.length,
    'the bank is exactly species x size', `${species.length} x ${TREE_SIZES.length} = ${bank.variants.length}`)
  check(bank.tiers.every((t) => t.geometries.length === bank.variants.length),
    'every tier holds one geometry per variant',
    bank.tiers.map((t) => t.geometries.length).join(' / '))

  // Strictly cheaper at every step, PER VARIANT -- the only form of the claim
  // that survives a bank spanning saplings to big oaks. Across the whole set the
  // ranges overlap by construction (a big pine's LOD1 is 601 triangles against a
  // birch sapling's 210 at LOD0), and that is not a ladder fault: no instance is
  // ever both. What would be a fault is one tree getting dearer as it recedes,
  // so each variant is walked down its own rungs.
  const lo = bank.tiers.map((t) => Math.min(...t.triangles))
  const hi = bank.tiers.map((t) => Math.max(...t.triangles))
  let descends = true
  let worstStep = ''
  for (let t = 1; t < bank.tiers.length; t++) {
    for (let v = 0; v < bank.variants.length; v++) {
      if (bank.tiers[t].triangles[v] >= bank.tiers[t - 1].triangles[v]) {
        descends = false
        worstStep = ` -- ${bank.variants[v].species} ${bank.variants[v].size} tier ${t - 1}->${t}: ` +
          `${bank.tiers[t - 1].triangles[v]} -> ${bank.tiers[t].triangles[v]}`
      }
    }
  }
  check(descends, 'every variant gets cheaper at every rung of its own ladder',
    bank.tiers.map((t, i) => `${lo[i]}-${hi[i]}`).join(' | ') + worstStep)
  // The one assertion that pins the far bill. Both ends of each range, because
  // "every variant" is the claim: the cross is three quads for all twelve and
  // the billboard is one triangle for all twelve, whatever the species or size.
  const last = bank.tiers.length - 1
  check(lo[last] === 1 && hi[last] === 1 && lo[last - 1] === 6 && hi[last - 1] === 6,
    'the far tier is a one-triangle billboard and the one before it a three-plane cross',
    `${lo[last - 1]}-${hi[last - 1]} then ${lo[last]}-${hi[last]} triangles`)

  // BatchedMesh refuses the whole arena over one stray attribute, so this is a
  // boot failure for the entire forest rather than a wrong-looking tree.
  const layouts = new Set()
  let indexed = true
  for (const t of bank.tiers) {
    for (const g of t.geometries) {
      layouts.add(Object.keys(g.attributes).sort().join(','))
      if (!g.index) indexed = false
    }
  }
  check(layouts.size === 1, 'every geometry in the bank has one identical attribute layout',
    [...layouts][0])
  check(indexed, 'every geometry in the bank is indexed')

  const impostors = treeImpostorLayers()
  check(impostors.length === species.length,
    'one impostor layer per species, none shared', `${impostors.join(', ')}`)
  check(impostors.every((l) => Number.isInteger(l) && l >= 0 && l < LAYER_COUNT),
    'every impostor layer is inside the texture array', `${LAYER_COUNT} layers`)
  // Both card tiers wear the SAME photograph. If they ever stopped, the far
  // tier would cost a second bake and a second layer for no visible gain.
  const cross = bank.tiers[bank.tiers.length - 2].geometries
  const card = bank.tiers[bank.tiers.length - 1].geometries
  const sameLayer = variants.every((v, i) =>
    cross[i].attributes.texLayer.getX(0) === v.impostorLayer &&
    card[i].attributes.texLayer.getX(0) === v.impostorLayer)
  check(sameLayer, 'both card tiers hang on their species impostor layer, so neither costs a second bake')
  // How material.js tells the two apart: an EXACTLY vertical normal marks the
  // card that billboardVertex may spin, and the cross must stay under
  // CARD_UP_MARK or a whole forest starts rotating about its trunks. Exactly,
  // not merely over the line: the marker is the entire contract between the two
  // tiers that share one baked layer, so the billboard's normal is (0, 1, 0) and
  // anything else is a card that has picked up a fan it must not have.
  const cardUp = card.every((g) => {
    const n = g.attributes.normal
    for (let i = 0; i < n.count; i++) {
      if (n.getX(i) !== 0 || n.getY(i) !== 1 || n.getZ(i) !== 0) return false
    }
    return true
  })
  const crossDown = cross.every((g) => {
    const n = g.attributes.normal
    for (let i = 0; i < n.count; i++) if (n.getY(i) >= CARD_UP_MARK) return false
    return true
  })
  check(cardUp, 'the billboard tier wears exactly (0, 1, 0), which is what marks it spinnable',
    `CARD_UP_MARK ${CARD_UP_MARK}`)
  check(crossDown, 'the cross tier stays under the marker, so billboardVertex leaves it alone')

  // THE FAR CARD IS ONE TRIANGLE. Which way up is a fact about the species'
  // outline -- a conifer IS a triangle apex-up, a lollipop is close to one
  // apex-down -- and impostor.js's `tri` note carries the rasterised fraction of
  // each silhouette that each choice keeps. Checked against the SPECIES TABLE
  // and then against the built geometry, because buildTreeBank throwing on a
  // missing billboardTri only helps if the field is still meaningful.
  const tris = Object.entries(TREE_SPECIES).map(([s, sp]) => [s, sp.billboardTri])
  check(tris.every(([, t]) => t === 'up' || t === 'down'),
    "every species says which way up its billboard is, 'up' or 'down'",
    tris.map(([s, t]) => `${s} ${t}`).join(', '))
  check(tris.every(([s, t]) => (t === 'up') === (s === 'pine')),
    'the conifer is the only apex-up billboard; every broadleaf crown is a lollipop',
    tris.filter(([, t]) => t === 'up').map(([s]) => s).join(', '))

  // One plane, three corners, one triangle -- for every variant, not just the
  // one that happened to be looked at. This is the single largest line in the
  // forest's bill, so a variant that fell back to a quad doubles it silently.
  const oneTri = card.every((g) =>
    g.attributes.position.count === 3 && g.index.count === 3)
  check(oneTri, 'every billboard is three vertices and one triangle',
    card.map((g) => `${g.attributes.position.count}v/${g.index.count / 3}t`).join(' '))

  // RepeatWrapping is global on the array (textures.js), so a uv outside the
  // unit square does not clamp, it WRAPS -- and what it wraps onto is the far
  // side of this card's own layer. A triangle that overhung the square would
  // sample the wrong part of its own photograph.
  let uvOut = 0
  for (const g of card) {
    const uv = g.attributes.uvProj
    for (let i = 0; i < uv.count; i++) {
      if (uv.getX(i) < 0 || uv.getX(i) > 1 || uv.getY(i) < 0 || uv.getY(i) > 1) uvOut++
    }
  }
  check(uvOut === 0, 'every billboard uv lies inside the layer, which RepeatWrapping does not forgive',
    `${uvOut} of ${card.length * 3} corners outside [0, 1]`)

  // SYMMETRY ABOUT u = 0.5 IS LOAD-BEARING, not tidiness. billboardVertex
  // mirrors u per instance (`if (bbA.x < 0.0) vUvProj.x = 1.0 - vUvProj.x`) to
  // double the number of distinct silhouettes in the bed for free -- and a
  // mirrored footprint is only the same shape as the original if the footprint
  // is symmetric. An asymmetric uv triple would show half the forest a sheared
  // photograph: the world triangle would stay put while the picture on it slid.
  const symmetric = card.every((g) => {
    const uv = g.attributes.uvProj
    const us = []
    for (let i = 0; i < uv.count; i++) us.push(uv.getX(i))
    us.sort((a, b) => a - b)
    for (let i = 0; i < us.length; i++) if (!near(us[i] + us[us.length - 1 - i], 1, 1e-6)) return false
    return true
  })
  check(symmetric, 'every billboard uv footprint is symmetric about u = 0.5',
    'which is the whole of what makes billboardVertex\'s per-instance mirror free')

  // The two ways `tri` is not allowed to be asked for. A canopy fan signs its
  // outward lean off the corner's own x, and a triangle has a corner sitting on
  // x = 0 where that sign does not exist; and a typo'd tri would otherwise fall
  // through to a quad, which is the failure this whole block is about.
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  check(throws(() => buildImpostorCard(1, 2, 0, 1, { tri: 'up', canopy: true })),
    'a triangle refuses a canopy fan rather than picking a sign at its apex')
  check(throws(() => buildImpostorCard(1, 2, 0, 1, { upNormal: true, tri: 'sideways' })),
    "a tri that is not 'up', 'down' or false throws instead of quietly becoming a quad")
  // The fern billboard is deliberately still a QUAD -- a rosette has no corner
  // it can spare -- and that is the default, so it has to stay the default.
  const quad = buildImpostorCard(1, 2, 0, 1, { upNormal: true })
  check(quad.userData.impostor.triangles === 2 && quad.userData.impostor.tri === false,
    'a card asked for without `tri` is still a quad, which is what the fern billboard takes',
    `${quad.userData.impostor.triangles} triangles`)
  quad.dispose()

  note('bank size', `${Math.round(bank.bytes / 1024)} KB, ${bank.triangles} triangles across all tiers`)
}

// --- 7. the shipped ladder --------------------------------------------------
//
// THE TWO FILES THAT HAVE TO AGREE ABOUT HOW MANY TIERS THERE ARE, and neither
// imports the other. tree-bank.js builds the rungs and trees.js LOD_BANDS says
// where they change hands; LOD_BANDS is exported on TREE_TUNING, so this reads
// the real constant rather than a copy of it. One band too few and the last
// tier is unreachable, which is the expensive direction -- the coarsest tier
// holds tens of thousands of instances, so stranding it means the whole far
// field draws at the tier above and the triangle bill multiplies with nothing
// looking wrong. One too many and update() indexes past the end of the ladder.
//
// The tiers are pinned BY INDEX and by absolute count here, not relative to the
// end of the ladder the way the bank section's checks are. "The last tier is one
// triangle" stays true when a tier is inserted or dropped, and a tier appearing
// or disappearing is the exact change this section exists to catch. So: four
// tiers with a billboard and three without, tier 2 six triangles for every
// variant, tier 3 one, and tiers 0 and 1 the only rungs that cost more than six.

console.log('\n-- the shipped ladder --')

{
  const noBillboard = buildTreeBank({ seed: 1, billboard: false })

  check(bank.tiers.length === 4,
    'the shipped bank is four tiers: the LOD0 mesh, the LOD1 mesh, the cross, the billboard',
    `${bank.tiers.length} tiers of ${bank.variants.length} variants each`)
  check(noBillboard.tiers.length === 3,
    'without a billboard the bank is three tiers and the cross is the last one',
    `${noBillboard.tiers.length} tiers`)
  // The same relationship the grass gate holds, and the same two failures: one
  // band too few leaves the last tier unreachable, one too many walks off the
  // end of the ladder in update().
  check(LOD_BANDS.length + 1 === bank.tiers.length,
    'LOD_BANDS carries exactly one boundary fewer than the bank has tiers, so no tier is stranded',
    `${LOD_BANDS.length} bands [${LOD_BANDS.join(', ')}] against ${bank.tiers.length} tiers`)

  // Both ends of both card tiers, over every variant: the cross is three quads
  // and the billboard is one triangle whatever the species or the size.
  const crossTris = bank.tiers[2].triangles
  check(crossTris.every((t) => t === 6),
    'every tier-2 geometry is exactly six triangles, the three-plane cross',
    `${Math.min(...crossTris)}-${Math.max(...crossTris)} over ${crossTris.length} variants`)
  const cardTris = bank.tiers[3].triangles
  check(cardTris.every((t) => t === 1),
    'every tier-3 geometry is exactly one triangle, the spun billboard',
    `${Math.min(...cardTris)}-${Math.max(...cardTris)} over ${cardTris.length} variants`)

  // The other half of the same statement: exactly two rungs are real trees, so a
  // third mesh tier appearing on the ladder fails here rather than passing as a
  // slightly dearer forest -- and a mesh tier quietly becoming cards fails too,
  // which is the direction that costs the near field its silhouettes.
  const overSix = bank.tiers.map((t) => t.triangles.filter((n) => n > 6).length)
  check(overSix[0] === bank.variants.length && overSix[1] === bank.variants.length
    && overSix.slice(2).every((n) => n === 0),
    'tiers 0 and 1 are the only tiers that cost more than six triangles, so the near field is the only mesh',
    `variants over six triangles per tier: ${overSix.join(' / ')}`)

  for (const t of noBillboard.tiers) for (const g of t.geometries) g.dispose()
}

// --- 8. the bands -----------------------------------------------------------

console.log('\n-- lod --')

{
  let ordered = true
  for (let t = 1; t < LOD_BANDS.length; t++) if (LOD_BANDS[t] <= LOD_BANDS[t - 1]) ordered = false
  check(ordered, 'the bands increase', LOD_BANDS.join(' -> '))

  // The dead band has to fit INSIDE the gap to the next boundary, or an
  // instance held sticky at tier t is already past where tier t+1 begins and
  // the two tiers fight over it every frame.
  let fits = true
  const shown = []
  for (let t = 0; t < LOD_BANDS.length; t++) {
    const out = LOD_BANDS[t] * (1 + LOD_HYSTERESIS)
    const next = t + 1 < LOD_BANDS.length ? LOD_BANDS[t + 1] : DRAW_RADIUS
    if (out >= next) fits = false
    shown.push(`${LOD_BANDS[t]}->${out.toFixed(1)}<${next}`)
  }
  check(fits, 'each band pushed out by the hysteresis still stops short of the next',
    shown.join(' '))

  // Grass gates the opposite of this and is right to: a carpet whose last band
  // sits outside the full-density radius is spending its finest tier on
  // instances that have already been thinned away. A forest is not a carpet --
  // the near ladder has to reach past the thinning or a tree at 90 m is a flat
  // billboard while its neighbour at 79 m still carries three silhouettes -- so
  // the violation is recorded rather than gated.
  const last = LOD_BANDS[LOD_BANDS.length - 1]
  if (last > FULL_RADIUS) {
    note('the last LOD band reaches PAST the full-density radius, unlike grass',
      `${last} m band, ${FULL_RADIUS} m full -- trees between them are thinned but still crosses`)
  } else {
    check(true, 'the last LOD band does not reach past the full-density radius',
      `${last} m band, ${FULL_RADIUS} m full`)
  }

  check(DRAW_RADIUS > last * 10, 'the draw radius is a horizon rather than a band',
    `${DRAW_RADIUS} m against a ${last} m last band`)
}

// --- 9. the vertical squash -------------------------------------------------
//
// Y_SQUASH turns each band sphere into an ellipsoid twice as tall as it is
// wide, because instY is the tree's ROOT and the tree is not -- a player on a
// ledge 9 m above a stand is 9 m from its roots and no distance at all from its
// canopy. The tier walk is re-derived here exactly as update() runs it, out
// from the finest tier, so the gate cannot pass by agreeing with a copy.

console.log('\n-- the vertical squash --')

{
  const bandSq = LOD_BANDS.map((b) => b * b)
  const tierOf = (horiz, vert, squash) => {
    const ey = vert * (squash ? Y_SQUASH : 1)
    const d2 = horiz * horiz + ey * ey
    for (let t = 0; t < bandSq.length; t++) if (d2 < bandSq[t]) return t
    return bandSq.length
  }

  check(Y_SQUASH > 0 && Y_SQUASH < 1, 'the squash shortens the vertical leg rather than lengthening it',
    `Y_SQUASH ${Y_SQUASH}`)

  // (a) A STRICTLY SHRINKING MAP. Over the whole near field the squash may
  // promote an instance to a finer tier and may never demote one, because it
  // only ever makes a distance smaller.
  let demoted = 0
  let promoted = 0
  for (let h = 0; h <= 140; h += 1) {
    for (let v = -140; v <= 140; v += 1) {
      const a = tierOf(h, v, true)
      const b = tierOf(h, v, false)
      if (a > b) demoted++
      if (a < b) promoted++
    }
  }
  check(demoted === 0, 'the squash never pushes an instance to a coarser tier',
    `over a 141 x 281 m grid: ${demoted} demoted, ${promoted} promoted`)

  // (b) NEARLY INERT AT EYE HEIGHT. Standing on flat ground the eye is ~2 m
  // above a root, and the squash must not quietly widen the bands there -- the
  // whole cost of the near field is how many instances fall inside the first
  // one. Measured as the change in each band's horizontal cross-section, which
  // is what actually decides the count.
  //
  // THE BOUND IS 3% OF RADIUS, and it is loose because it is a percentage of the
  // wrong quantity: a fixed 2 m of eye height is a larger fraction of an 8 m
  // band than of a 15 m one, so the tightest band is always the worst case here
  // and shrinking it makes this number grow with nothing having gone wrong. At
  // 8 m it is +2.5%, which is +5% of AREA, and at 0.05 trees per square metre
  // that is half a tree. Half a tree is the honest size of the effect; the 2%
  // this replaced was chosen against a 10 m band and would fail a 7 m one.
  const EYE_OVER_ROOT = 2
  let inert = true
  const perBand = []
  for (const b of LOD_BANDS) {
    const plain = Math.sqrt(Math.max(0, b * b - EYE_OVER_ROOT ** 2))
    const squashed = Math.sqrt(Math.max(0, b * b - (EYE_OVER_ROOT * Y_SQUASH) ** 2))
    const grew = squashed / plain - 1
    if (grew >= 0.03) inert = false
    perBand.push(`${b} m: ${plain.toFixed(3)} -> ${squashed.toFixed(3)} m, +${pct(grew)}` +
      ` (${pct((squashed / plain) ** 2 - 1)} of area)`)
  }
  check(inert, `at ${EYE_OVER_ROOT} m of eye height the squash widens every band by under 3%`,
    perBand.join('; '))

  // (c) WHAT IT IS FOR. Stand on a ledge level with a crown, just past the
  // horizontal reach the plain sphere allows at that height, and you are nearer
  // the LEAVES than a player at the trunk's foot the same distance out -- who
  // gets a mesh. Measured to the root you are outside the band and get a card.
  //
  // Demonstrated at the LAST MESH BOUNDARY rather than the first, because that
  // is the crossing worth arguing about: the first one swaps one mesh for
  // another and this one swaps a tree for three quads. Both the height and the
  // distance are derived from that band, so this stays a real demonstration when
  // the band moves -- OUT is a metre past the plain reach, and the canopy is
  // held under the band so a plain reach exists at all.
  const meshTiers = bank.tiers.filter((t) => t.triangles.some((n) => n > 6)).length
  const MESH = meshTiers - 1
  const MESH_BAND = LOD_BANDS[MESH]
  const CANOPY = Math.min(9, Math.floor(MESH_BAND * 0.6))
  const OUT = Math.ceil(Math.sqrt(MESH_BAND ** 2 - CANOPY ** 2)) + 1
  check(tierOf(OUT, CANOPY, true) <= MESH && tierOf(OUT, CANOPY, false) > MESH,
    `a canopy ${CANOPY} m up and ${OUT} m out is still a mesh only under the squash`,
    `tier ${tierOf(OUT, CANOPY, false)} -> ${tierOf(OUT, CANOPY, true)}, ` +
    `mesh to tier ${MESH} and its ${MESH_BAND} m band`)
  const reach = (squash) =>
    Math.sqrt(Math.max(0, MESH_BAND ** 2 - (CANOPY * (squash ? Y_SQUASH : 1)) ** 2))
  note(`the mesh's horizontal reach at ${CANOPY} m of height`,
    `${reach(false).toFixed(2)} m -> ${reach(true).toFixed(2)} m`)

  // The instance counts a band is budgeted for are a MAXIMUM, which is only
  // true if a band's horizontal cross-section is widest on the ground. It is:
  // r(y) = sqrt(b^2 - (y * Y_SQUASH)^2) falls monotonically from y = 0.
  let widestOnTheGround = true
  for (const b of LOD_BANDS) {
    let prev = Infinity
    for (let y = 0; y <= b / Y_SQUASH; y += 0.25) {
      const r = Math.sqrt(Math.max(0, b * b - (y * Y_SQUASH) ** 2))
      const pop = Math.PI * r * r * DENSITY
      if (pop > prev + 1e-9) widestOnTheGround = false
      prev = pop
    }
  }
  check(widestOnTheGround, 'every band holds the most instances at zero altitude, so the ladder counts are a ceiling',
    LOD_BANDS.map((b) => `${b} m: ${Math.round(Math.PI * b * b * DENSITY)} at ground, 0 by ${(b / Y_SQUASH).toFixed(0)} m up`).join('; '))
}

// --- 10. the scatter --------------------------------------------------------
//
// A headless world -- flat ground, no water, no snow -- so the only thing that
// varies is the thinning law itself.

console.log('\n-- scatter --')

const texArray = buildTextureArray()
const flat = {
  scatterAt: (x, z, cell, out) => { out.h = 60; out.tan = 0; return out },
  heightAt: () => 60,
  snowLineAt: () => 9999,
}
const dry = { isSubmerged: () => false }
const EYE = 60 + 1.6

const trees = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: DRAW_RADIUS })
trees.place(0, 0)

{
  const s = trees.stats
  const ideal = Math.PI * FULL_RADIUS ** 2 * DENSITY
    + 2 * Math.PI * FULL_RADIUS * DENSITY * (DRAW_RADIUS - FULL_RADIUS)
  const disc = Math.PI * DRAW_RADIUS ** 2 * DENSITY
  check(s.placed / ideal > 0.9 && s.placed / ideal < 1.35,
    'the placed count matches the graded-thinning integral',
    `${s.placed} placed, ${Math.round(ideal)} ideal, ${(s.placed / ideal).toFixed(3)}x`)
  check(s.placed < disc * 0.15, 'graded thinning costs under a seventh of a hard disc at the same density',
    `${s.placed} against ${Math.round(disc)}`)
  check(s.used <= s.pool, 'the instance pool covers the boot scatter',
    `${s.used} used of ${s.pool}`)
  check(s.pool < s.placed * 2, 'the pool bound is not wildly over-sized',
    `${s.pool} for ${s.placed} placed`)
}

// The rim dissolve. Read BEFORE the first update(), because a cross-dissolve in
// flight stamps a timer over this very channel -- the first of the two accepted
// artefacts in trees.js's header -- and the gone-distance is not there to read
// while it does.
{
  const fade = trees.batch._colorsTexture.image.data
  let mismatched = 0
  let outOfRange = 0
  let rankAboveKeep = 0
  let minGone = Infinity
  let maxGone = -Infinity
  for (const tile of trees.tiles.values()) {
    const keep = trees.uAt[tile.q]
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const gone = fade[id * 4 + 3]
      const want = Math.min(FULL_RADIUS / trees.rankAt[id], DRAW_RADIUS)
      if (Math.abs(gone - want) > 1e-2) mismatched++
      if (gone < FULL_RADIUS - 1e-3 || gone > DRAW_RADIUS + 1e-3) outOfRange++
      if (!(trees.rankAt[id] < keep)) rankAboveKeep++
      minGone = Math.min(minGone, gone)
      maxGone = Math.max(maxGone, gone)
    }
  }
  check(mismatched === 0, 'every tree carries fullRadius / its own rank as its gone-distance',
    `${trees.placed} instances, ${mismatched} disagree`)
  check(outOfRange === 0, 'no gone-distance falls inside the full-density radius or past the horizon',
    `${minGone.toFixed(1)} m to ${maxGone.toFixed(1)} m`)
  check(rankAboveKeep === 0, 'every standing tree ranks below its own tile keep-fraction',
    `${rankAboveKeep} of ${trees.placed}`)

  // THE TWO POPULATIONS. The tile quantisation deliberately errs dense -- a
  // tile's far corner is thinned as though it stood at its near corner, and the
  // level always rounds toward keeping -- so the PLACED density runs 6-20% over
  // the law. The per-instance rim dissolve is what puts it back: a tree past
  // its own gone-distance is fully dithered out, so the DRAWN density is the
  // law to within a couple of percent. Both are measured, because a drift in
  // the second is a visible density error while a drift in the first is only
  // instances nobody sees.
  const ring = (r0, r1) => {
    let placed = 0
    let drawn = 0
    for (const tile of trees.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const d = Math.hypot(trees.instX[id], trees.instZ[id])
        if (d < r0 || d >= r1) continue
        placed++
        if (d < fade[id * 4 + 3]) drawn++
      }
    }
    const area = Math.PI * (r1 * r1 - r0 * r0)
    const want = DENSITY * FULL_RADIUS / ((r0 + r1) / 2)
    return { placed: placed / area, drawn: drawn / area, want }
  }
  let lawHolds = true
  let overKept = true
  const rings = []
  for (const [a, b] of [[190, 210], [390, 410], [790, 810], [1190, 1210]]) {
    const r = ring(a, b)
    if (Math.abs(r.drawn / r.want - 1) > 0.06) lawHolds = false
    if (r.placed < r.drawn) overKept = false
    rings.push(`${(a + b) / 2} m ${r.drawn.toFixed(4)}/${r.want.toFixed(4)}`)
  }
  check(lawHolds, 'the drawn density follows fullRadius / d to within 6% at 200, 400, 800 and 1200 m',
    rings.join('  '))
  check(overKept, 'the tile quantisation errs dense at every range, never sparse')

  let drawn = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (Math.hypot(trees.instX[id], trees.instZ[id]) < fade[id * 4 + 3]) drawn++
    }
  }
  const ideal = Math.PI * FULL_RADIUS ** 2 * DENSITY
    + 2 * Math.PI * FULL_RADIUS * DENSITY * (DRAW_RADIUS - FULL_RADIUS)
  check(near(drawn / ideal, 1, 0.05), 'the whole visible forest matches the integral to within 5%',
    `${drawn} drawn of ${trees.placed} placed, ${Math.round(ideal)} ideal`)
}

// The tier walk, re-derived with the same ellipsoid and the same out-from-the-
// finest loop update() uses. Every instance is born a card, so this first
// update() is the one with no sticky tiers in it and the plain bands apply.
{
  trees.update(0, EYE, 0)
  const s = trees.stats
  const bandSq = LOD_BANDS.map((b) => b * b)
  const nearSq = (LOD_BANDS[LOD_BANDS.length - 1] + NEAR_MARGIN) ** 2
  const counts = new Array(bank.tiers.length).fill(0)
  let wrong = 0
  let bill = 0
  for (const tile of trees.tiles.values()) {
    const dx = (tile.tx + 0.5) * TILE
    const dz = (tile.tz + 0.5) * TILE
    const isNear = dx * dx + dz * dz < nearSq
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const tier = trees.tierAt[id]
      counts[tier]++
      bill += bank.tiers[tier].triangles[trees.variantAt[id]]
      let want = trees.cardTier
      if (isNear) {
        const ex = trees.instX[id]
        const ey = (trees.instY[id] - EYE) * Y_SQUASH
        const ez = trees.instZ[id]
        const d2 = ex * ex + ey * ey + ez * ez
        for (let t = 0; t < bandSq.length; t++) if (d2 < bandSq[t]) { want = t; break }
      }
      if (tier !== want) wrong++
    }
  }
  check(wrong === 0, 'every instance sits in the tier its own ellipsoidal distance asks for',
    `${counts.join(' / ')} across the tiers, ${wrong} wrong`)
  let widens = counts[0] > 0
  for (let t = 1; t < counts.length; t++) if (counts[t] <= counts[t - 1]) widens = false
  check(widens, 'every tier holds more instances than the tier finer than it',
    counts.join(' / '))
  check(s.tris - trees.fadeTris === bill,
    'the reported triangle bill is the sum of what each instance actually draws',
    `${s.tris} reported, ${bill} from the ladder, ${trees.fadeTris} in cross-dissolves`)
  check(s.tris < 200000, 'a kilometre and a half of forest stays under 200k triangles',
    `${s.tris} triangles for ${s.placed} trees`)
  note('boot cost', `bank ${s.buildMs.toFixed(0)} ms, place ${s.placeMs.toFixed(0)} ms, ` +
    `${s.tiles} tiles of which ${s.nearTiles} near, ${s.bankKB} KB of geometry`)
  // FADE_MAX_INFLIGHT, hit exactly once: every tree is born a card and the
  // whole near field is promoted on the first frame there is. It degrades to a
  // plain pop, which at boot nobody sees.
  note('cross-dissolves in flight after the first update', `${s.fading}`)
}

// --- 9c. the shape of the cross-dissolve ramp -------------------------------
//
// WHAT THIS IS FOR. A cross-dissolve conserves coverage -- the two halves take
// complementary thresholds, so the prop is fully covered from the first frame to
// the last and the only visible signal is the MIX. That is what stops the
// silhouette thinning, and it is also why the opening of the ramp is invisible:
// at 10% the arriving tier is scattered single pixels over a face the departing
// tier still fills. A LINEAR ramp therefore spends its first fifth looking like
// nothing has happened, which is read as latency between crossing the band and
// the animation starting -- reported from the headset as "a split second before
// the dithering even starts", on a fade that was in fact already running.
//
// So the ramp is eased and the promise is about its FRONT, not its length. Both
// numbers are read out of material.js's own shader source rather than restated
// here, because the thing that would break this is somebody making the ramp
// linear again, and a copy of the curve in the gate would go on passing.
{
  const src = readFileSync(new URL('../src/material.js', import.meta.url), 'utf8')
  check(/uPropClock - fadeT0 \) \*\s*\n\s*\$\{\(1 \/ PROP_FADE_SECONDS\)/.test(src),
    'the shader runs its clock off PROP_FADE_SECONDS itself, not off a second copy of the number',
    `interpolated into the GLSL as ${(1 / PROP_FADE_SECONDS).toFixed(6)}/s`)
  check(PROP_FADE_SECONDS <= 0.25,
    'and the window is a quarter second or less, so a swap resolves before it can be stared at',
    `${PROP_FADE_SECONDS * 1000} ms`)

  // The ease, evaluated rather than pattern-matched: p is linear time through
  // the window, `ease` is what the shader turns it into, and `ease` is also the
  // arriving tier's coverage because the threshold test is `abs(vPropFade) <=
  // fadeT` against a uniform dither.
  const easeSrc = /^\s*fadeP = ([^;]+);/m.exec(src)[1]
  const ease = (p) => Function('fadeP', `return ${easeSrc.replace(/([0-9])\.0\b/g, '$1')}`)(p)
  check(Math.abs(ease(0)) < 1e-9 && Math.abs(ease(1) - 1) < 1e-9,
    'the ease still starts at nothing and ends at everything, so no tier is clipped or held over',
    `f(0) = ${ease(0)}, f(1) = ${ease(1)}`)
  let mono = true
  for (let i = 1; i <= 100; i++) if (ease(i / 100) <= ease((i - 1) / 100)) mono = false
  check(mono, 'and it never goes backwards, so the dissolve does not visibly reverse mid-swap')
  check(ease(0.1) >= 0.18,
    'and it clears nearly a fifth of the swap in the first tenth of the window -- the anti-lag promise',
    `${(ease(0.1) * 100).toFixed(0)}% arrived after ${(PROP_FADE_SECONDS * 100).toFixed(0)} ms, ` +
    `against 10% if the ramp were linear`)
  check(ease(0.3) >= 0.5,
    'and half of it in the first three tenths, which is where the eye actually reads the transition',
    `${(ease(0.3) * 100).toFixed(0)}%`)

  // COVERAGE IS CONSERVED AT EVERY POINT ON THE RAMP, which is the other half of
  // the design and the one the ease must not break. Simulated against the real
  // fragment test: the departing half keeps a pixel when `1 - f > ign`, the
  // arriving half when `f > 1 - ign`, and the two must partition every pixel.
  let holes = 0
  let doubles = 0
  for (let i = 0; i <= 20; i++) {
    const f = ease(i / 20)
    for (let j = 0; j < 64; j++) {
      const ign = (j + 0.5) / 64
      const out = 1 - f > ign
      const arr = f > 1 - ign
      if (!out && !arr) holes++
      if (out && arr) doubles++
    }
  }
  check(holes === 0 && doubles === 0,
    'and exactly one of the two halves survives at every pixel, at every point on the ramp',
    `21 ramp positions x 64 dither levels, ${holes} holes, ${doubles} doubled`)
}

// --- 10b. what the cursor calls a tree, and where it thinks the tree is ------
//
// The /v2 readout names whatever is under the cursor. Two promises here: the
// NAME is one somebody can act on -- `oak-2`, a species and which of the four
// sizes, not the bank index 11 -- and the pick VOLUME is the tree's own trunk
// and crown rather than a species constant. The second is what stopped the
// cursor pointing through a trunk at the fern behind it: a 3 m radius column
// from the ground up put the eye INSIDE the tree at any range you would inspect
// one from, and pick.js ranks a volume from inside by its far wall.

console.log('\n-- the cursor names a tree --')

{
  const names = trees.variantName
  check(names.length === trees.variantCount, 'every variant has a name', `${names.length} of ${trees.variantCount}`)
  check(names[0] === 'pine-0' && names[6] === 'oak-2' && names[15] === 'aspen-3',
    'and the name is the species and which size it is, not the bank index',
    `variant 0/6/15 are ${names[0]}/${names[6]}/${names[15]}`)
  check(new Set(names).size === names.length, 'and no two variants answer to the same name')

  // A real instance out of the placed bed, so this is the path pickProp walks.
  const tile = trees.tiles.values().next().value
  const id = tile.ids[0]
  const v = trees.variantAt[id]
  check(trees.nameAt(id) === names[v], 'a placed instance names its own variant', trees.nameAt(id))

  const trunk = trees.pickTrunkAt(id, { radius: 0, base: 0, rise: 0 })
  const crown = trees.pickCrownAt(id, { radius: 0, base: 0, rise: 0 })
  const scale = trees.instScale[id]
  check(near(trunk.base, 0, 1e-9) && near(trunk.rise, crown.base, 1e-6),
    'the trunk volume runs from the ground to exactly where the crown starts',
    `trunk 0 to ${trunk.rise.toFixed(2)} m, crown from ${crown.base.toFixed(2)} m`)
  check(near(crown.base + crown.rise, trees.unitHeight[v] * scale, 1e-5),
    'and the crown stops at the tip rather than somewhere above it',
    `${(crown.base + crown.rise).toFixed(2)} m against a ${(trees.unitHeight[v] * scale).toFixed(2)} m tree`)
  check(trunk.radius > 0 && trunk.radius < crown.radius / 3,
    'the trunk is picked at trunk width and not at crown width -- the whole bug',
    `trunk r ${trunk.radius.toFixed(2)} m, crown r ${crown.radius.toFixed(2)} m`)
  check(trunk.radius > trees.unitTrunkRadius[v] * scale,
    'and a little wider than the published base radius, because the trunk is a cone drawn inside it',
    `${trunk.radius.toFixed(3)} m against ${(trees.unitTrunkRadius[v] * scale).toFixed(3)} m`)

  // Over every placed tree, not just the first: the old constant was 3 m for
  // all of them, and a sapling is a third the size of its full-grown variant.
  const scratchSize = { radius: 0, base: 0, rise: 0 }
  let widest = 0
  let narrowest = Infinity
  let n = 0
  for (const t of trees.tiles.values()) {
    for (let k = 0; k < t.n; k++) {
      trees.pickTrunkAt(t.ids[k], scratchSize)
      widest = Math.max(widest, scratchSize.radius)
      narrowest = Math.min(narrowest, scratchSize.radius)
      n++
    }
  }
  check(widest < 3 && narrowest > 0.01 && widest / narrowest > 5,
    'and the volumes track the trees rather than being one number for the forest',
    `${n} trees, trunk pick radius ${narrowest.toFixed(3)} to ${widest.toFixed(3)} m, all under the 3 m the constant used`)
}

trees.dispose()

// --- 11. placement ----------------------------------------------------------

console.log('\n-- placement --')

{
  const one = (field, water) => {
    const t = new Trees(new THREE.Scene(), field, water, texArray, { seed: 7, radius: 200 })
    t.place(0, 0)
    const n = t.placed
    t.dispose()
    return n
  }
  const wet = { isSubmerged: () => true }
  const cliff = { ...flat, scatterAt: (x, z, cell, out) => { out.h = 60; out.tan = 9; return out } }
  const sunk = { ...flat, scatterAt: (x, z, cell, out) => { out.h = 1; out.tan = 0; return out } }
  const snowy = { ...flat, snowLineAt: () => -1000 }

  const baseline = one(flat, dry)
  check(baseline > 1000, 'the reference bed does grow trees', `${baseline} at 200 m`)
  check(one(flat, wet) === 0, 'no trees in a lake')
  check(one(cliff, dry) === 0, 'no trees on a cliff')
  check(one(sunk, dry) === 0, 'no trees below the minimum elevation')
  check(one(snowy, dry) === 0, 'no trees far above the snow line')

  // Tighter than the grass bed on both axes it shares with it, which is the
  // whole reason trees carry their own PLACEMENT block: a slope grass holds is
  // not a slope a tree stands on, and the tree line is above the grass line.
  check(PLACEMENT.maxSlopeDeg < GRASS_TUNING.PLACEMENT.maxSlopeDeg,
    'trees give up on a slope before grass does',
    `${PLACEMENT.maxSlopeDeg} deg against grass at ${GRASS_TUNING.PLACEMENT.maxSlopeDeg}`)
  check(PLACEMENT.minElev > GRASS_TUNING.PLACEMENT.minElev,
    'trees start higher up the shore than grass does',
    `${PLACEMENT.minElev} m against grass at ${GRASS_TUNING.PLACEMENT.minElev} m`)
  check(PLACEMENT.sink > 0 && PLACEMENT.sink < 0.5,
    'a trunk is sunk far enough to hide its foot and not far enough to shorten it',
    `${PLACEMENT.sink} m`)
  check(PLACEMENT_CELL <= TILE / 4,
    'the field is sampled finer than the tile it scatters into',
    `${PLACEMENT_CELL} m cell in a ${TILE} m tile`)
  check(QUANT >= 2 && Math.pow(2, 1 / QUANT) < 1.25,
    'the thinning quantisation steps by under a quarter, so a tile regrows in small bands',
    `2^(1/${QUANT}) = ${Math.pow(2, 1 / QUANT).toFixed(3)}`)
  check(NEAR_MARGIN >= TILE, 'the near set reaches at least a tile past the last band',
    `${NEAR_MARGIN} m margin on a ${TILE} m tile`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all tree checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
