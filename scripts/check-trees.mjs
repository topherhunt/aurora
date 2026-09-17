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
//   THE COARSE MESH STOPS BEING THE SAME TREE. treeLod(p, 1) is tree.js's
//   coarse tier, and it is LOD0 with cheaper WOOD and nothing else: a 3-sided
//   trunk, one fin per limb, the same card per spray. Two
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
//   THE ATTRIBUTE LAYOUT DRIFTS. Every bank geometry shares one material and
//   one program, and the bank welds two generators' output -- prop-layout wood,
//   Lambert-layout crown -- into that program's layout, `color` included, so a
//   stray `uv` or a missing `color` is a boot failure for the entire forest.

import { readFileSync } from 'node:fs'

import * as THREE from 'three'

import {
  TREE_DEFAULTS, TREE_SPECIES, treeLod, resolveTree, buildTree, crownProfile,
} from '../src/props/tree.js'
import { buildTreeBank, treeVariants, treeImpostorLayers, plantedSpecies, TREE_BANK_SPECIES } from '../src/props/tree-bank.js'
import { buildImpostorCard } from '../src/props/impostor.js'
import {
  CARD_UP_MARK, PROP_FADE_SECONDS, setPropClock, getPropClock, setPropFadeTimerAt, setPropSolidAt,
} from '../src/material.js'
import { Trees, TREE_TUNING } from '../src/v2/render/trees.js'
import { ROCK_STAND_MIN } from '../src/v2/render/rocks.js'
import { RIM_AT } from '../src/v2/render/rim.js'
import { GRASS_TUNING } from '../src/v2/render/grass.js'
import { LAYER_COUNT, IMAGE_LAYERS, CLUMP_VARIANTS, buildTextureArray } from '../src/textures.js'
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
  TILE, QUANT, NEAR_MARGIN, PLACEMENT, PLACEMENT_CELL, SCALE, TREELINE, BIOME,
  CLUMP_FROM, CLUMP_FULL, CLUMPS_PER_TILE } = TREE_TUNING

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
    // that is deliberate -- the cards are the tree's silhouette at 8 to 22.5 m and
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
  // Swept across heights as well as seeds even though the bank now ships one
  // height per species: the parity is a property of treeLod's rng streams, and a
  // sweep that only ever asks at the shipped height would not notice a rescale
  // that had started depending on it.
  for (const size of [0.5, 1.0, 1.5]) {
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

const bank = buildTreeBank({ billboard: true })
const variants = treeVariants()
const bankSpecies = plantedSpecies()

{
  check(bank.variants.length === bankSpecies.length,
    'the bank is exactly one variant per planted species', `${bank.variants.length} variants: ${bankSpecies.join(', ')}`)
  // The forest is pine-only until the broadleaf crowns look right; a broadleaf
  // reappearing here is a decision, not a drift.
  check(bankSpecies.length === 1 && bankSpecies[0] === 'pine',
    'the world plants only the pine', `planted: ${bankSpecies.join(', ')}`)
  check(bank.tiers.every((t) => t.geometries.length === bank.variants.length),
    'every tier holds one geometry per variant',
    bank.tiers.map((t) => t.geometries.length).join(' / '))

  // Strictly cheaper at every step, PER VARIANT. Across the whole set the ranges
  // can overlap -- a pine's LOD1 against a birch's LOD0 -- and that is not a
  // ladder fault, since no instance is ever both. What would be a fault is one
  // tree getting dearer as it recedes, so each variant is walked down its own
  // rungs.
  const lo = bank.tiers.map((t) => Math.min(...t.triangles))
  const hi = bank.tiers.map((t) => Math.max(...t.triangles))
  let descends = true
  let worstStep = ''
  for (let t = 1; t < bank.tiers.length; t++) {
    for (let v = 0; v < bank.variants.length; v++) {
      if (bank.tiers[t].triangles[v] >= bank.tiers[t - 1].triangles[v]) {
        descends = false
        worstStep = ` -- ${bank.variants[v].species} tier ${t - 1}->${t}: ` +
          `${bank.tiers[t - 1].triangles[v]} -> ${bank.tiers[t].triangles[v]}`
      }
    }
  }
  check(descends, 'every variant gets cheaper at every rung of its own ladder',
    bank.tiers.map((t, i) => `${lo[i]}-${hi[i]}`).join(' | ') + worstStep)
  // The one assertion that pins the far bill. Both ends of the range, because
  // "every variant" is the claim: the billboard is one triangle for all four,
  // whatever the species, and the rung above it is a mesh in the hundreds.
  const last = bank.tiers.length - 1
  check(lo[last] === 1 && hi[last] === 1 && lo[last - 1] > 6,
    'the far tier is a one-triangle billboard and the one before it a mesh',
    `${lo[last - 1]}-${hi[last - 1]} then ${lo[last]}-${hi[last]} triangles`)

  // One material and one program over the whole arena, so every geometry has
  // to carry exactly what createPropMaterial({ vertexColors, hemFray }) reads:
  // the two generators' wood and crown are welded into this layout and the
  // card is padded to it, and a stray `uv` or a missing `color` is a boot
  // failure for the entire forest rather than a wrong-looking tree.
  const PROP_LAYOUT = 'color,hem,normal,position,texLayer,uvProj'
  const layouts = new Set()
  let indexed = true
  for (const t of bank.tiers) {
    for (const g of t.geometries) {
      layouts.add(Object.keys(g.attributes).sort().join(','))
      if (!g.index) indexed = false
    }
  }
  check(layouts.size === 1 && layouts.has(PROP_LAYOUT),
    'every geometry in the bank wears the prop layout with a baked colour',
    [...layouts].join(' | '))
  check(indexed, 'every geometry in the bank is indexed')
  // The crown's shade is what `color` is for: a tree with every vertex white
  // is one whose bake fell out of the weld, and it would light flat.
  const shaded = bank.tiers[0].geometries.every((g) => {
    const c = g.attributes.color
    for (let i = 0; i < c.count; i++) if (c.getX(i) < 0.99) return true
    return false
  })
  check(shaded, 'every LOD0 tree carries some baked shade in its colour, so the weld kept the bake')

  // THE CUTOUT STOPS AT 8 m. Only the near tier wears the holed mat and a hem
  // the material can fray; LOD1 and the card are solid to the edge, so no
  // alpha-tested rim shimmers in the distance. Both halves per tier: a far tier
  // wearing the holed mat is a hole in the tree, and one carrying a hem is an
  // edge the shader would eat.
  const layersOf = (g) => new Set(Array.from(g.attributes.texLayer.array))
  const hemMax = (g) => Math.max(...g.attributes.hem.array)
  const nearHoled = variants.every((v, i) => {
    const g = bank.tiers[0].geometries[i]
    const sp = TREE_BANK_SPECIES[v.species]
    return layersOf(g).has(sp.nearMat) && !layersOf(g).has(sp.matLayer) && hemMax(g) === 1
  })
  check(nearHoled, 'the near tier wears the holed mat and carries a hem to fray',
    variants.map((v) => `${v.species} ${TREE_BANK_SPECIES[v.species].nearMat}`).join(', '))
  const farSolid = bank.tiers.slice(1).every((t) => t.geometries.every((g, i) => {
    const sp = TREE_BANK_SPECIES[variants[i].species]
    return !layersOf(g).has(sp.nearMat) && hemMax(g) === 0
  }))
  check(farSolid, 'every tier past the near one is solid to the edge, with hem 0 and the solid mat')
  // The near mat is a real file of its own, not the solid one under a second
  // name, and the alpha in it is the whole point.
  const nearFiles = variants.map((v) => IMAGE_LAYERS[TREE_BANK_SPECIES[v.species].nearMat])
  check(nearFiles.every((f, i) => f && f !== IMAGE_LAYERS[variants[i].matLayer]),
    'each near mat is its own image in the array', nearFiles.join(', '))
  // The crown's mat is a layer of the array like every other prop's skin.
  const matsIn = variants.every((v) => Number.isInteger(v.matLayer) && v.matLayer >= 0 && v.matLayer < LAYER_COUNT)
  check(matsIn, 'every species mat is a layer inside the texture array',
    variants.map((v) => `${v.species} ${v.matLayer}`).join(', '))

  const impostors = treeImpostorLayers()
  check(impostors.length === bankSpecies.length,
    'one impostor layer per planted species, none shared', `${impostors.join(', ')}`)
  check(impostors.every((l) => Number.isInteger(l) && l >= 0 && l < LAYER_COUNT),
    'every impostor layer is inside the texture array', `${LAYER_COUNT} layers`)
  // The card wears its species' own photograph and no other, which is what
  // keeps one bake and one layer serving the whole far field.
  const card = bank.tiers[bank.tiers.length - 1].geometries
  const sameLayer = variants.every((v, i) => card[i].attributes.texLayer.getX(0) === v.impostorLayer)
  check(sameLayer, 'the card tier hangs on its species impostor layer, so it costs no second bake')
  // How material.js knows to spin it: an EXACTLY vertical normal. Exactly, not
  // merely over the line -- the marker is the entire contract between a spun
  // card and a fixed one on the same baked layer, so the billboard's normal is
  // (0, 1, 0) and anything else is a card that has picked up a fan it must not
  // have.
  const cardUp = card.every((g) => {
    const n = g.attributes.normal
    for (let i = 0; i < n.count; i++) {
      if (n.getX(i) !== 0 || n.getY(i) !== 1 || n.getZ(i) !== 0) return false
    }
    return true
  })
  check(cardUp, 'the billboard tier wears exactly (0, 1, 0), which is what marks it spinnable',
    `CARD_UP_MARK ${CARD_UP_MARK}`)

  // THE FAR CARD IS ONE TRIANGLE. Which way up is a fact about the species'
  // outline -- a conifer IS a triangle apex-up, a lollipop is close to one
  // apex-down -- and impostor.js's `tri` note carries the rasterised fraction of
  // each silhouette that each choice keeps. Checked against the SPECIES TABLE
  // and then against the built geometry, because buildTreeBank throwing on a
  // missing billboardTri only helps if the field is still meaningful.
  const tris = Object.entries(TREE_BANK_SPECIES).map(([s, sp]) => [s, sp.billboardTri])
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
// or disappearing is the exact change this section exists to catch. So: three
// tiers with a billboard and two without, tier 2 one triangle for every variant,
// and tiers 0 and 1 the only rungs that cost more than six.

console.log('\n-- the shipped ladder --')

{
  const noBillboard = buildTreeBank({ billboard: false })

  check(bank.tiers.length === 3,
    'the shipped bank is three tiers: the LOD0 mesh, the LOD1 mesh, the billboard',
    `${bank.tiers.length} tiers of ${bank.variants.length} variants each`)
  check(noBillboard.tiers.length === 2,
    'without a billboard the bank is two tiers and LOD1 is the last one',
    `${noBillboard.tiers.length} tiers`)
  // The same relationship the grass gate holds, and the same two failures: one
  // band too few leaves the last tier unreachable, one too many walks off the
  // end of the ladder in update().
  check(LOD_BANDS.length + 1 === bank.tiers.length,
    'LOD_BANDS carries exactly one boundary fewer than the bank has tiers, so no tier is stranded',
    `${LOD_BANDS.length} bands [${LOD_BANDS.join(', ')}] against ${bank.tiers.length} tiers`)

  // Both ends of the card tier, over every variant: the billboard is one
  // triangle whatever the species or the size.
  const cardTris = bank.tiers[2].triangles
  check(cardTris.every((t) => t === 1),
    'every tier-2 geometry is exactly one triangle, the spun billboard',
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
  // the near ladder has to reach past the thinning or a tree just outside the
  // last band is a flat card while its neighbour just inside still carries a
  // mesh -- so the violation is recorded rather than gated.
  const last = LOD_BANDS[LOD_BANDS.length - 1]
  if (last > FULL_RADIUS) {
    note('the last LOD band reaches PAST the full-density radius, unlike grass',
      `${last} m band, ${FULL_RADIUS} m full -- trees between them are thinned but still meshes`)
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
  // another and this one swaps a tree for a card. Both the height and the
  // distance are derived from that band, so this stays a real demonstration when
  // the band moves -- OUT sits midway between the plain reach and the squashed
  // one, which is the whole window the squash opens, and the canopy is held
  // under the band so a plain reach exists at all.
  const meshTiers = bank.tiers.filter((t) => t.triangles.some((n) => n > 6)).length
  const MESH = meshTiers - 1
  const MESH_BAND = LOD_BANDS[MESH]
  const CANOPY = Math.min(9, Math.floor(MESH_BAND * 0.6))
  const OUT = (Math.sqrt(MESH_BAND ** 2 - CANOPY ** 2)
    + Math.sqrt(MESH_BAND ** 2 - (CANOPY * Y_SQUASH) ** 2)) / 2
  check(tierOf(OUT, CANOPY, true) <= MESH && tierOf(OUT, CANOPY, false) > MESH,
    `a canopy ${CANOPY} m up and ${OUT.toFixed(2)} m out is still a mesh only under the squash`,
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

// THE TWO POPULATIONS. Single trees stand in every tile whose level is under
// clumpQ -- the near corner inside the clump edge, which is the first ladder
// rung at or past CLUMP_FROM -- at full density inside FULL_RADIUS and
// thinned as fullRadius / d beyond it (with CLUMP_FROM at FULL_RADIUS that
// band is empty: no single is ever thinned); past the edge a tile holds
// CLUMPS_PER_TILE clump cards, full to CLUMP_FULL and thinned as CLUMP_FULL / d
// beyond. Every law below is asked of each tile in the mode it is in.
const CLUMP_DENSITY = CLUMPS_PER_TILE / (TILE * TILE)
const CLUMP_EDGE = trees.clumpFrom
const singlesIdeal = Math.PI * FULL_RADIUS ** 2 * DENSITY
  + 2 * Math.PI * FULL_RADIUS * DENSITY * (CLUMP_EDGE - FULL_RADIUS)
const clumpsIdeal = Math.PI * (CLUMP_FULL ** 2 - CLUMP_EDGE ** 2) * CLUMP_DENSITY
  + 2 * Math.PI * CLUMP_FULL * CLUMP_DENSITY * (DRAW_RADIUS - CLUMP_FULL)
const ideal = singlesIdeal + clumpsIdeal
// The rings each law is measured over, as [r0, r1, clumpy]: each inside one
// population's tiles (a single tile can reach a tile's diagonal past the
// edge), and wide enough that the jitter of a few thousand candidates against
// the ring's edges stays under the tolerance. The area-weighted mean of 1 / d
// over an annulus is 1 / its mid-radius exactly.
const LAW_RINGS = [[50, 95, false], [95, 135, false], [250, 350, true], [375, 425, true], [750, 850, true], [1100, 1300, true]]
if (LAW_RINGS.some(([, r1, clumpy]) => !clumpy && r1 > CLUMP_EDGE) || LAW_RINGS.some(([r0, , clumpy]) => clumpy && r0 < CLUMP_EDGE + TILE * Math.SQRT2)) {
  throw new Error(`check-trees: a law ring straddles the clump edge at ${CLUMP_EDGE.toFixed(1)} m`)
}

{
  const s = trees.stats
  const disc = Math.PI * DRAW_RADIUS ** 2 * DENSITY
  check(s.placed / ideal > 0.9 && s.placed / ideal < 1.35,
    'the placed count matches the graded-thinning integral over both populations',
    `${s.placed} placed, ${Math.round(ideal)} ideal (${Math.round(singlesIdeal)} singles + ${Math.round(clumpsIdeal)} clumps), ${(s.placed / ideal).toFixed(3)}x`)
  let clumpTiles = 0
  let wrongMode = 0
  let modeless = 0
  // The picture a clump instance draws is its species' quad plus a per-instance
  // layer shift, which is the only thing that varies between two clumps of one
  // species; a single tree carries no shift.
  const shifts = new Map()
  let shifted = 0
  for (const tile of trees.tiles.values()) {
    if (tile.clumpy) clumpTiles++
    if (tile.clumpy !== (tile.q >= trees.clumpQ)) wrongMode++
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const clumpInstance = trees.tierAt[id] === trees.clumpTier
      if (clumpInstance !== tile.clumpy) modeless++
      const shift = trees.batch.layer[id]
      if (tile.clumpy) shifts.set(shift, (shifts.get(shift) || 0) + 1)
      else if (shift !== 0) shifted++
    }
  }
  check(clumpTiles > 0 && clumpTiles < s.tiles && wrongMode === 0,
    'a tile is clumps exactly when its level is at or past clumpQ, and both kinds of tile exist',
    `${clumpTiles} clump tiles of ${s.tiles}, clumpQ ${trees.clumpQ} (${Math.round(Math.sqrt(trees.loSq[trees.clumpQ]))} m), ${wrongMode} in the wrong mode`)
  check(modeless === 0, 'every instance in a clump tile wears the clump tier and no single tree does',
    `${modeless} of ${s.placed} disagree`)
  const shiftKeys = [...shifts.keys()].sort()
  check(shifted === 0 && shiftKeys.length === CLUMP_VARIANTS && shiftKeys.every((v, i) => v === i)
    && Math.min(...shifts.values()) > Math.max(...shifts.values()) * 0.8,
    'every clump carries a layer shift naming one of the CLUMP_VARIANTS pictures, in even measure, and no single tree carries one',
    `shifts ${shiftKeys.map((v) => `${v}: ${shifts.get(v)}`).join(', ')}, ${shifted} singles shifted`)
  const nearestClump = Math.min(...[...trees.tiles.values()].filter((t) => t.clumpy)
    .map((t) => Math.hypot(t.tx * TILE + (t.tx < 0 ? TILE : 0), t.tz * TILE + (t.tz < 0 ? TILE : 0))))
  check(nearestClump >= CLUMP_EDGE - 1e-3 && CLUMP_EDGE >= CLUMP_FROM, 'no clump tile reaches inside the clump edge, which is at or past CLUMP_FROM',
    `nearest clump tile edge at ${nearestClump.toFixed(1)} m, clump edge ${CLUMP_EDGE.toFixed(1)} m, CLUMP_FROM ${CLUMP_FROM} m`)
  check(s.placed < disc * 0.15, 'graded thinning costs under a seventh of a hard disc at the same density',
    `${s.placed} against ${Math.round(disc)}`)
  check(s.used <= s.pool, 'the instance pool covers the boot scatter',
    `${s.used} used of ${s.pool}`)
  check(s.pool < s.placed * 2, 'the pool bound is not wildly over-sized',
    `${s.pool} for ${s.placed} placed`)
}

// The rim dissolve. The gone-distance is CPU state now -- rim.gone, not the
// colour texel, which carries a clock reading or the never-fade 1.0 and never a
// distance -- so this no longer has to run before the first update().
{
  let mismatched = 0
  let outOfRange = 0
  let rankAboveKeep = 0
  let minGone = Infinity
  let maxGone = -Infinity
  let minClumpGone = Infinity
  for (const tile of trees.tiles.values()) {
    const keep = tile.clumpy ? trees.clumpUAt[tile.q] : trees.uAt[tile.q]
    const full = tile.clumpy ? CLUMP_FULL : FULL_RADIUS
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const gone = trees.rim.gone[id]
      const want = Math.min(full / tile.rank[k], DRAW_RADIUS)
      if (Math.abs(gone - want) > 1e-2) mismatched++
      if (gone < full - 1e-3 || gone > DRAW_RADIUS + 1e-3) outOfRange++
      if (!(tile.rank[k] < keep)) rankAboveKeep++
      if (tile.clumpy) minClumpGone = Math.min(minClumpGone, gone)
      else {
        minGone = Math.min(minGone, gone)
        maxGone = Math.max(maxGone, gone)
      }
    }
  }
  check(mismatched === 0, 'every tree carries fullRadius / its own rank, and every clump CLUMP_FULL / its own rank, as its gone-distance',
    `${trees.placed} instances, ${mismatched} disagree`)
  check(outOfRange === 0, 'no gone-distance falls inside its population\'s full-density radius or past the horizon',
    `singles ${minGone.toFixed(1)} m to ${maxGone.toFixed(1)} m, clumps from ${minClumpGone.toFixed(1)} m`)
  check(rankAboveKeep === 0, 'every standing instance ranks below its own tile keep-fraction',
    `${rankAboveKeep} of ${trees.placed}`)

  // THE TWO POPULATIONS. The tile quantisation deliberately errs dense -- a
  // tile's far corner is thinned as though it stood at its near corner, and the
  // level always rounds toward keeping -- so the PLACED density runs 6-20% over
  // the law. The per-instance gone-distance is what puts it back: inside its own
  // gone-distance the population is the law to within a couple of percent. Both
  // are measured, because a drift in the second is a visible density error while
  // a drift in the first is only instances nobody sees.
  //
  // This is the LAW's population and not the drawn one -- the rim takes a tree
  // at RIM_AT of its gone-distance, which is a constant factor under this, and
  // the block after the first update() measures what is actually on screen.
  //
  // Each ring is asked of ONE population, and sited where that population's
  // tiles cover the whole ring: singles inside CLUMP_FROM less a tile, clumps
  // past it. The mode boundary itself is a tile-quantised step and is measured
  // as such above.
  const ring = (r0, r1, clumpy) => {
    let placed = 0
    let drawn = 0
    for (const tile of trees.tiles.values()) {
      if (tile.clumpy !== clumpy) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const d = Math.hypot(trees.instX[id], trees.instZ[id])
        if (d < r0 || d >= r1) continue
        placed++
        if (d < trees.rim.gone[id]) drawn++
      }
    }
    const area = Math.PI * (r1 * r1 - r0 * r0)
    const d = (r0 + r1) / 2
    const want = clumpy ? CLUMP_DENSITY * Math.min(1, CLUMP_FULL / d) : DENSITY * Math.min(1, FULL_RADIUS / d)
    return { placed: placed / area, drawn: drawn / area, want }
  }
  let lawHolds = true
  let overKept = true
  const rings = []
  for (const [a, b, clumpy] of LAW_RINGS) {
    const r = ring(a, b, clumpy)
    if (Math.abs(r.drawn / r.want - 1) > 0.06) lawHolds = false
    if (r.placed < r.drawn) overKept = false
    rings.push(`${(a + b) / 2} m ${r.drawn.toFixed(4)}/${r.want.toFixed(4)}`)
  }
  check(lawHolds, 'inside its own gone-distance the population follows min(1, fullRadius / d) for singles inside the clump edge and min(1, CLUMP_FULL / d) for clumps out to the horizon, to within 6%',
    rings.join('  '))
  check(overKept, 'the tile quantisation errs dense at every range, never sparse')

  let drawn = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (Math.hypot(trees.instX[id], trees.instZ[id]) < trees.rim.gone[id]) drawn++
    }
  }
  check(near(drawn / ideal, 1, 0.05), 'the whole forest inside its gone-distances matches the two-population integral to within 5%',
    `${drawn} of ${trees.placed} placed, ${Math.round(ideal)} ideal`)
}

// The tier walk, re-derived with the same ellipsoid and the same out-from-the-
// finest loop update() uses. Every instance is born a card, so this first
// update() is the one with no sticky tiers in it and the plain bands apply.
{
  trees.update(0, EYE, 0)
  const s = trees.stats
  const bandSq = LOD_BANDS.map((b) => b * b)
  const nearSq = (LOD_BANDS[LOD_BANDS.length - 1] + NEAR_MARGIN) ** 2
  const counts = new Array(trees.tierCount).fill(0)
  const tierBill = new Array(trees.tierCount).fill(0)
  let wrong = 0
  let bill = 0
  // Trees the rim has dissolved away. They are still resident and still hold
  // whatever tier they last wore, so they belong in neither the ladder audit nor
  // the triangle bill -- the batch is not drawing them at all.
  let hidden = 0
  for (const tile of trees.tiles.values()) {
    const dx = (tile.tx + 0.5) * TILE
    const dz = (tile.tz + 0.5) * TILE
    const isNear = dx * dx + dz * dz < nearSq
    if (isNear && tile.clumpy) wrong++
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (trees.rim.isHidden(id)) {
        hidden++
        continue
      }
      const tier = trees.tierAt[id]
      counts[tier]++
      tierBill[tier] += trees.tierTris[tier][trees.variantAt[id]]
      bill += trees.tierTris[tier][trees.variantAt[id]]
      let want = tile.clumpy ? trees.clumpTier : trees.cardTier
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
  check(wrong === 0, 'every instance sits in the tier its own ellipsoidal distance asks for, and no clump tile is in the near set',
    `${counts.join(' / ')} across the tiers, ${wrong} wrong`)
  let widens = counts[0] > 0
  for (let t = 1; t < counts.length; t++) if (counts[t] <= counts[t - 1]) widens = false
  check(widens, 'every tier holds more instances than the tier finer than it, the clump tier most of all',
    counts.join(' / '))
  // The row trees.js's ladder table is copied from.
  note('triangles per tier', tierBill.map((t) => `${(t / 1000).toFixed(1)}k`).join(' / '))
  // Plus the cross-dissolve ghosts, which are drawn and are deliberately not in
  // the ladder walk above: a duplicate is not a tree, it is the tier a tree has
  // just left, still on screen for a quarter second.
  check(s.tris === bill + trees.fadeTris + trees.retiringTris,
    'the reported triangle bill is the sum of what each instance actually draws',
    `${s.tris} reported, ${bill} from the ladder plus ${trees.fadeTris} in flight and ${trees.retiringTris} retiring`)
  // WHAT THE RIM ACTUALLY DRAWS, which is the number the player sees and is a
  // constant RIM_AT under the law measured above -- the rim takes a tree at the
  // midpoint of the old dissolve band, so the drawn density is that fraction of
  // fullRadius / d at every range. A drift here is a forest that has thinned or
  // thickened, which is exactly what choosing either end of the band would have
  // done: see the trigger note in render/rim.js.
  {
    let held = true
    const rows = []
    for (const [r0, r1, clumpy] of LAW_RINGS) {
      let shown = 0
      for (const tile of trees.tiles.values()) {
        if (tile.clumpy !== clumpy) continue
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          if (trees.rim.isHidden(id)) continue
          const d = Math.hypot(trees.instX[id], trees.instZ[id])
          if (d >= r0 && d < r1) shown++
        }
      }
      const have = shown / (Math.PI * (r1 * r1 - r0 * r0))
      const d = (r0 + r1) / 2
      // A population at full density has a gone-distance past its full
      // radius, which the rim never reaches at this range, so it takes none.
      const want = clumpy
        ? CLUMP_DENSITY * Math.min(1, RIM_AT * CLUMP_FULL / d)
        : DENSITY * Math.min(1, RIM_AT * FULL_RADIUS / d)
      if (Math.abs(have / want - 1) > 0.06) held = false
      rows.push(`${d} m ${have.toFixed(4)}/${want.toFixed(4)}`)
    }
    check(held, 'the DRAWN density is each population\'s law at RIM_AT of its full radius to within 6%, singles inside the clump edge and clumps out to the horizon',
      rows.join('  '))
  }
  check(hidden === s.rimHidden, 'and the rim agrees about how many trees it is not drawing',
    `${hidden} walked, ${s.rimHidden} reported`)
  let visibleMismatch = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (trees.batch.getVisibleAt(id) === trees.rim.isHidden(id)) visibleMismatch++
    }
  }
  check(visibleMismatch === 0, 'and every tree it hides is actually invisible in the arena',
    `${visibleMismatch} of ${s.placed} disagree`)

  // THE ARENA'S OWN BOOKKEEPING, which nothing above can see: one mesh per tier
  // and species, each drawing a dense prefix, and every visible instance in
  // exactly one of them at the tier it thinks it holds.
  {
    const arena = trees.batch
    let live = 0
    for (const mesh of arena.meshes) live += mesh.count
    let shown = 0
    let misplaced = 0
    for (const tile of trees.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (trees.rim.isHidden(id)) continue
        shown++
        const want = trees.tierIds[trees.tierAt[id]][trees.variantAt[id]]
        if (arena.geoAt[id] !== want || arena.slot[id] < 0) misplaced++
      }
    }
    // Every ghost holds a slot of its own, in the mesh of the tier its original
    // has just left -- that IS the cross-dissolve -- so the slot count runs one
    // ahead of the tree count per fade in flight.
    check(live === shown + trees.fades.length && misplaced === 0,
      'every drawn tree occupies exactly one slot, in the mesh for its own tier and species',
      `${live} slots across ${arena.meshes.length} meshes, ${shown} trees drawn, ` +
      `${trees.fades.length} dissolving duplicates, ${misplaced} misplaced`)

    // The slot map is a bijection both ways -- the swap-remove in _free is where
    // that would break, and it would break as one tree wearing another's matrix.
    let brokenOwner = 0
    for (let g = 0; g < arena.meshes.length; g++) {
      for (let sIdx = 0; sIdx < arena.meshes[g].count; sIdx++) {
        const id = arena.owner[g][sIdx]
        if (arena.slot[id] !== sIdx || arena.geoAt[id] !== g) brokenOwner++
      }
    }
    check(brokenOwner === 0, 'and every slot names the instance that names it back',
      `${brokenOwner} of ${live} slots disagree`)

    // Nothing is near its ceiling. A mesh that filled would THROW, so this is
    // the early warning rather than the failure.
    const worst = arena.meshes.reduce((w, mesh, g) =>
      Math.max(w, mesh.count / arena.capAt[g]), 0)
    check(worst < 0.9, 'and no mesh is within a tenth of the capacity _tierCaps gave it',
      `fullest mesh at ${(worst * 100).toFixed(0)}% of its cap`)
  }
  check(s.tris < 200000, 'a kilometre and a half of forest stays under 200k triangles',
    `${s.tris} triangles for ${s.placed} trees`)
  note('boot cost', `bank ${s.buildMs.toFixed(0)} ms, place ${s.placeMs.toFixed(0)} ms, ` +
    `${s.tiles} tiles of which ${s.nearTiles} near, ${s.bankKB} KB of geometry`)
  note('draw calls', `${trees.batch.meshes.length} meshes, ` +
    `${trees.batch.meshes.filter((m) => m.count > 0).length} of them non-empty`)
}

// --- 9b1. the two ablations --------------------------------------------------
//
// The menu switches that answer "what do trees actually cost", and both are
// measurements rather than settings, so what matters is that each removes ONE
// thing and puts it back exactly. `tree tiers` has to empty the mesh meshes --
// an emptied InstancedMesh is skipped before its draw call, which is where the
// saving is, and a tier still holding one instance would keep the call and the
// number would mean nothing. `tree leaf cutout` has to restore the material's
// OWN threshold, not a number typed in a switch case, or an A/B leaves the
// forest running at the wrong alphaTest for the rest of the session.
{
  const meshTiers = bank.tiers.length - 1
  // The arena ids of every MESH tier, asked of the same map update() steers by.
  const meshGeo = []
  for (let t = 0; t < meshTiers; t++) meshGeo.push(...trees.tierIds[t])
  const meshInstances = () => meshGeo.reduce((n, g) => n + trees.batch.meshes[g].count, 0)

  trees.setCardsOnly(true)
  trees.update(0, EYE, 0)
  let offLadder = 0
  for (const tile of trees.tiles.values()) {
    const want = tile.clumpy ? trees.clumpTier : trees.cardTier
    for (let k = 0; k < tile.n; k++) if (trees.tierAt[tile.ids[k]] !== want) offLadder++
  }
  const meshLive = meshInstances()
  check(offLadder === 0 && meshLive === 0,
    'cards only takes every tree down to the card tier, leaves the clumps as they are, and empties the mesh meshes so their draw calls go with them',
    `${offLadder} trees off the card tier, ${meshLive} instances still in ${meshTiers} mesh tiers`)
  check(trees.stats.cardsOnly === true, 'and the stats row says so, which is what the readout flags')

  trees.setCardsOnly(false)
  trees.update(0, EYE, 0)
  const backOnMesh = meshInstances()
  check(backOnMesh > 0 && trees.stats.cardsOnly === false,
    'and turning it back on refills the mesh tiers, so the ablation is a measurement and not a one-way door',
    `${backOnMesh} instances back on the mesh tiers`)

  const shipped = trees.material.alphaTest
  check(shipped > 0, 'the shipped forest is an alpha CUTOUT, which is what makes the other switch worth throwing',
    `alphaTest ${shipped}`)
  const version = trees.material.version
  trees.setCutout(false)
  check(trees.material.alphaTest === 0 && trees.material.version > version,
    'no cutout zeroes the reject and recompiles, since USE_ALPHATEST is keyed off the threshold at compile time',
    `alphaTest ${trees.material.alphaTest}, version ${version} -> ${trees.material.version}`)
  check(trees.stats.cutout === false, 'and the stats row says so')
  // Assemble the program the way check-shaders does, so the claim is about
  // the GLSL and not the flag: off, no `discard` survives anywhere in it.
  const assemble = () => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    }
    trees.material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
    return shader.fragmentShader
  }
  const offKey = trees.material.customProgramCacheKey()
  check(!assemble().includes('discard'),
    'and it compiles the dissolve discard out with it, so the opaque program has no discard at all and early depth reject is on',
    `key ${offKey}`)
  trees.setCutout(true)
  check(trees.material.alphaTest === shipped && trees.stats.cutout === true,
    'and turning it back on restores the threshold the material shipped with rather than a number typed beside it',
    `alphaTest ${trees.material.alphaTest}, shipped ${shipped}`)
  check(assemble().includes('abs( vPropFade ) <= fadeT ) discard') && trees.material.customProgramCacheKey() !== offKey,
    'and the dissolve discard comes back under a different program key, so the two programs are never conflated',
    `key ${trees.material.customProgramCacheKey()}`)
}

// --- 9b2. a dissolve never retracts -----------------------------------------
//
// THE ARTEFACT THIS EXISTS FOR, reported from the headset: fly forward and far
// trees dissolve IN and then, a second later, dissolve back OUT again. It reads
// as the world rubber-banding away from the player, and it is worse than a
// pop-in, because a pop-in at least resolves. A prop that has been shown has
// made a promise; the only honest way to take it back is for the player to
// travel far enough that the prop is genuinely behind them.
//
// Two things caused it and both are boundary arithmetic in rim.js -- a
// hysteresis quoted in METRES against gone-distances that run from 8 m to
// 1.5 km, and the sweep's motion slack pushing the SHOW boundary outward, which
// admits props that are outside their own keep radius and hands them back when
// the slack decays. Neither throws, both are invisible standing still, and the
// second only appears above about 20 m/s. So the camera is flown here.
//
// WHAT IS MEASURED is not "did anything dissolve out" -- flying past a tree and
// leaving it behind is the mechanism working. It is whether a tree that
// dissolved IN ever got properly inside its own trigger radius before it went:
// one that only ever grazed the boundary was shown by the slack or by the
// hysteresis being too narrow at its distance, and is exactly the churn above.
//
// 20 m/s IS THE SPEED THE ZERO HOLDS AT. The slack scales with camera speed, so
// flying faster widens the very thing being gated: at 20 m/s the fixed rim shows
// none of this in six seconds and the boundary arithmetic it replaced shows 15,
// which is the signal this gate is for. At 60 m/s a few dozen still slip through
// and nothing here claims otherwise.

const mOrig = new THREE.Matrix4()
const mDup = new THREE.Matrix4()

console.log('\n-- a dissolve does not retract --')
{
  const SPEED = 20
  const FLY_S = 4
  const TOTAL_S = 6
  const DT = 1 / 72
  const fly = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: DRAW_RADIUS })
  fly.place(0, 0)
  const n = fly.maxInstances
  const wasHidden = new Uint8Array(n)
  const shown = new Uint8Array(n)
  const minD = new Float32Array(n).fill(Infinity)
  let ins = 0
  let outs = 0
  let grazed = 0
  let z = 0
  // Settle first, and take the standing-still picture as the baseline: at boot
  // every instance is FRESH and resolves with no transition at all, which is not
  // a dissolve and must not be counted as one.
  setPropClock(0)
  fly.update(0, EYE, 0)
  for (let i = 0; i < n; i++) wasHidden[i] = fly.rim.isHidden(i) ? 1 : 0
  for (let f = 1; f * DT < TOTAL_S; f++) {
    const t = f * DT
    if (t < FLY_S) z -= SPEED * DT
    setPropClock(t)
    fly.update(0, EYE, z)
    for (let i = 0; i < n; i++) {
      const hidden = fly.rim.isHidden(i) ? 1 : 0
      if (!hidden) {
        const dx = fly.instX[i]
        const dy = fly.instY[i] - EYE
        const dz = fly.instZ[i] - z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < minD[i]) minD[i] = d
      }
      if (hidden !== wasHidden[i]) {
        if (hidden) {
          outs++
          // A retraction only counts against the rim if the tree never came
          // inside its own trigger AT ALL. That is the whole claim: a prop shown
          // by the slack is one standing outside the radius its own rank bought,
          // and it is the only kind that has nothing to lose by going again. A
          // tree that got inside and then left is the player having walked past
          // it, however narrowly -- how narrowly is set by its LATERAL offset
          // from the flight line, which is a fact about where it stands and not
          // about the rim.
          if (shown[i] && minD[i] > fly.rim.gone[i] * RIM_AT) grazed++
        } else {
          ins++
          shown[i] = 1
          minD[i] = Infinity
        }
        wasHidden[i] = hidden
      }
    }
  }
  check(ins > 200, 'flying forward brings trees in through the rim, so this gate has something to say',
    `${ins} dissolved in over ${FLY_S} s at ${SPEED} m/s`)
  check(grazed === 0,
    'and not one of them dissolved back out without the camera having gone properly past it',
    `${outs} dissolved out, ${grazed} of them never inside their own trigger`)
}

// --- 9b3. the LOD swap dissolves rather than cutting ------------------------
//
// EVERY BAND CROSSING IS A CROSS-DISSOLVE, at all three boundaries. The arena
// has no per-instance geometry, so the departing tier has to be held by a
// DUPLICATE INSTANCE living in the departing tier's own mesh, stamped with the
// same start as the original and the opposite direction. Which makes the failure
// modes bookkeeping rather than looks:
//
//   THE GHOST LEAKS. A duplicate whose fade is never retired is a second tree
//   standing inside the first forever, drawn, holding a pool id and a mesh slot.
//   A slow leak empties the pool, and running dry THROWS in _growTile.
//   THE HALVES DISAGREE ON THE START. The two thresholds are complements of one
//   clock reading; different readings mean coverage that does not sum to one,
//   and the tree flickers thin or doubles its silhouette for the window.
//   THE GHOST IS THE WRONG TREE. It carries its own matrix and tint, copied at
//   the moment of the swap, and a copy that missed either draws a differently
//   sized or differently lit tree inside the one dissolving.
//
// So the camera is walked and the invariant `placed + in flight + free = pool`
// is checked as it goes: that closes over all three.

console.log('\n-- the LOD swap dissolves --')
{
  // Far enough to carry a tree out through the LAST band, which the dead band
  // puts 12% further out going that way: a walk shorter than that margin never
  // sees the outward half of the far swap at all.
  const SPEED = 4
  const SECONDS = 5
  const walk = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: DRAW_RADIUS })
  walk.place(0, 0)
  const n = walk.maxInstances
  const prevTier = new Int8Array(n).fill(-1)
  // A pool id outlives the tree that held it, so a swap is only a swap for an id
  // that was standing in a tile on the previous frame too. Without this, an id
  // recycled into a new tile reads as its predecessor's tier changing.
  let seen = new Uint8Array(n)
  let prevSeen = new Uint8Array(n)
  const pairs = new Set()
  let swaps = 0
  let missed = 0
  let peakFlight = 0
  let leaks = 0
  let indexBroken = 0
  let wrongGhost = 0
  let startsDisagree = 0
  let gap = null
  let z = 0
  // BOOT IS NOT A SWAP, but it looks exactly like one: _growTile hands every new
  // tree the card tier, so the first update inside the near ring re-tiers a few
  // hundred at once and pins the in-flight ceiling for a fade window. The whole
  // burst is let through and retired before the walk starts.
  for (let f = 0; f < 24; f++) {
    setPropClock(f / 72)
    walk.update(0, EYE, 0)
  }
  for (let i = 0; i < n; i++) prevTier[i] = walk.tierAt[i]
  for (const tile of walk.tiles.values()) for (let k = 0; k < tile.n; k++) prevSeen[tile.ids[k]] = 1
  // What "the same start, opposite directions" looks like once material.js has
  // packed the two into one float. Taken from the fade API itself on a spare id
  // rather than typed in, so the gate keeps meaning that when the packing moves.
  const spare = walk.tiles.values().next().value.ids[0]
  setPropFadeTimerAt(walk.batch, spare, 12, true)
  const stampIn = walk.batch.fade[spare]
  setPropFadeTimerAt(walk.batch, spare, 12, false)
  const wantGap = stampIn - walk.batch.fade[spare]
  setPropSolidAt(walk.batch, spare)

  // THE MODE SWAP IS A CROSS-DISSOLVE. A tile crossing CLUMP_FROM either way
  // retires its whole population and grows the other one, and the promise is
  // that nothing pops: every old tree that was standing goes OUT through the
  // rim and every new one that shows comes IN, both stamped off the one prop
  // clock reading, so the two halves dither complementarily. Each frame's
  // tiles are snapshotted before the update so a swap can be told from a
  // tile that was simply thinned or thickened.
  const before = new Map()
  const stateBefore = new Uint8Array(n)
  const startBefore = new Float32Array(n)
  const snapshot = () => {
    before.clear()
    for (const [key, tile] of walk.tiles) {
      before.set(key, { clumpy: tile.clumpy, ids: tile.ids.slice(0, tile.n) })
    }
    stateBefore.set(walk.rim.state)
    startBefore.set(walk.rim.start)
  }
  const RIM_SOLID = 1
  const RIM_OUT = 2
  const RIM_IN = 4
  const modeSwaps = { toSingles: 0, toClumps: 0, oldCut: 0, oldOffClock: 0, newSnapped: 0, newOffClock: 0 }
  const auditSwaps = (now) => {
    now = Math.fround(now)
    const retiring = new Set(walk.retiring)
    for (const [key, tile] of walk.tiles) {
      const was = before.get(key)
      if (!was || was.clumpy === tile.clumpy) continue
      if (tile.clumpy) modeSwaps.toClumps++
      else modeSwaps.toSingles++
      for (const id of was.ids) {
        const state = stateBefore[id]
        if (state === RIM_SOLID) {
          // Standing: goes OUT on this frame's reading, and holds its slot.
          if (!retiring.has(id) || walk.rim.state[id] !== RIM_OUT) modeSwaps.oldCut++
          else if (walk.rim.start[id] !== now) modeSwaps.oldOffClock++
        } else if ((state === RIM_OUT || state === RIM_IN) && now - startBefore[id] < PROP_FADE_SECONDS) {
          // Mid-transition: it runs on unchanged (an IN retires once solid).
          // One whose window is up this frame has finished as hidden and been
          // freed -- and possibly handed to the new population already -- or as
          // solid and been retired, so only the ones still in flight are asked.
          if (!retiring.has(id) || !walk.rim.isBusy(id)) modeSwaps.oldCut++
        }
      }
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (walk.rim.isHidden(id)) continue
        if (!walk.rim.isBusy(id)) modeSwaps.newSnapped++
        else if (walk.rim.start[id] !== now) modeSwaps.newOffClock++
      }
    }
  }
  let retiringPeak = 0

  const FRAMES = Math.round(SECONDS * 72)
  for (let f = 1; f <= FRAMES; f++) {
    z -= SPEED / 72
    setPropClock(0.5 + f / 72)
    snapshot()
    walk.update(0, EYE, z)
    auditSwaps(getPropClock())
    retiringPeak = Math.max(retiringPeak, walk.retiring.length)

    seen.fill(0)
    for (const tile of walk.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        seen[i] = 1
        const tier = walk.tierAt[i]
        if (tier === prevTier[i]) continue
        if (prevSeen[i] && prevTier[i] >= 0 && tier >= 0) {
          swaps++
          pairs.add(`${prevTier[i]}>${tier}`)
          // The rim outranks the swap and owns the slot while it runs; every
          // other refusal is a ceiling, and the walk is slow enough not to reach
          // one (asserted separately through peakFlight).
          if (walk.fadeAt[i] < 0 && !walk.rim.isBusy(i)) missed++
        }
        prevTier[i] = tier
      }
    }
    const swap = prevSeen
    prevSeen = seen
    seen = swap

    peakFlight = Math.max(peakFlight, walk.fades.length)
    if (walk.placed + walk.fades.length + walk.retiring.length + walk.freeCount !== walk.maxInstances) leaks++
    // fadeAt is the index back, and the swap-remove that keeps `fades` dense
    // rewrites it. An entry it no longer names is a fade nothing can end early:
    // the rim cannot preempt it and a second crossing cannot finish it, so the
    // duplicate outlives its window and the sweep hands back a slot whose
    // original has already moved on.
    for (let k = 0; k < walk.fades.length; k++) if (walk.fadeAt[walk.fades[k].orig] !== k) indexBroken++

    // The ghosts, while they are up: same species, a tier the original is not
    // wearing, the original's own matrix, and a pair of stamps that differ by
    // one fixed bias -- which is what "the same start, opposite directions"
    // reduces to once material.js has packed them.
    for (const fade of walk.fades) {
      const g = walk.batch.geoAt[fade.dup]
      const vc = walk.variantCount
      if (g % vc !== walk.variantAt[fade.orig] || Math.floor(g / vc) === walk.tierAt[fade.orig]) {
        wrongGhost++
        continue
      }
      walk.batch.getMatrixAt(fade.orig, mOrig)
      walk.batch.getMatrixAt(fade.dup, mDup)
      for (let e = 0; e < 16; e++) if (mOrig.elements[e] !== mDup.elements[e]) wrongGhost++
      gap = walk.batch.fade[fade.orig] - walk.batch.fade[fade.dup]
      // A millisecond of slack: the fade-in half is packed against a bias of
      // 4096 and a float32 resolves half a millisecond there, so the two halves'
      // stamps quantize differently even when the start is the same reading.
      if (Math.abs(gap - wantGap) > 1e-3) startsDisagree++
    }
  }

  // Every band, crossed both ways: two pairs per boundary, and a boundary per
  // entry in lodBands. Derived so the gate keeps covering the WHOLE ladder when
  // a rung is added or retired rather than silently covering less of it.
  const wantPairs = walk.lodBands.length * 2
  check(swaps > 50 && pairs.size === wantPairs,
    'walking crosses every band in both directions, so this gate covers the whole ladder',
    `${swaps} swaps: ${[...pairs].sort().join(' ')}, ${wantPairs} pairs wanted`)
  check(missed === 0,
    'and every one of them dissolved rather than cut -- including the 8 m wood swap',
    `${missed} swaps with no duplicate and no rim fade to explain it`)
  check(peakFlight > 0 && peakFlight < TREE_TUNING.FADE_MAX_INFLIGHT,
    'a walking player never reaches the in-flight ceiling, so no swap of theirs pops',
    `${peakFlight} duplicates at the peak against a ceiling of ${TREE_TUNING.FADE_MAX_INFLIGHT}`)
  check(wrongGhost === 0,
    'and every duplicate is the same tree, at the same matrix, wearing the tier its original left',
    `${wrongGhost} mismatched`)
  check(startsDisagree === 0,
    'and both halves carry the same start, so their thresholds sum to full coverage',
    `${walk.fades.length} in flight, stamps ${gap === null ? 'n/a' : gap.toFixed(3)} apart, ${wantGap.toFixed(3)} wanted`)
  check(indexBroken === 0, 'and every fade in flight is the one its original names, so any of them can be ended early',
    `${indexBroken} entries orphaned from fadeAt`)
  check(leaks === 0, 'the pool closes every frame: placed + in flight + retiring + free = pool',
    `${walk.placed} + ${walk.fades.length} + ${walk.retiring.length} + ${walk.freeCount} = ${walk.maxInstances}`)
  check(modeSwaps.toSingles > 0,
    'walking carries tiles in across CLUMP_FROM, so this gate covers the clump-to-singles swap',
    `${modeSwaps.toSingles} tiles swapped to singles`)

  // THE RIM OUTRANKS THE SWAP and the callback that enforces it is easy to lose:
  // nothing throws without it, the ghost simply stays lit while its original
  // dithers away underneath, and what the player sees is a tree that will not
  // leave. Provoked directly rather than waited for.
  {
    const busy = walk.fades[0]
    const freeBefore = walk.freeCount
    walk.rim.retire(busy.orig, getPropClock())
    check(walk.fadeAt[busy.orig] === -1 && walk.freeCount === freeBefore + 1,
      'a rim dissolve starting mid-swap takes the duplicate back rather than stranding it',
      `pool ${freeBefore} -> ${walk.freeCount}`)
  }

  // A FLIGHT, WHICH IS WHERE THE CEILINGS ACTUALLY BIND. Half the forest changes
  // tier in a frame at this speed, so `_crossFade` spends most of it refusing:
  // the refusals have to be refusals -- a pop, which is what the swap was before
  // any of this -- and not a mesh filling up, which THROWS in _alloc and takes
  // the frame with it. Same invariants, so a fade orphaned by a second crossing
  // inside one window shows up here even though a walker never crosses twice
  // that fast.
  //
  // The speed it takes to fill the ceiling is a function of the LADDER: every
  // boundary is a ring of trees crossing, and the crossings per frame scale with
  // the ring's circumference. Retiring a rung retires its ring, so this is set
  // above what the ladder needs rather than at a walking pace.
  const FLIGHT_SPEED = 400
  let flightLeaks = 0
  let flightOrphans = 0
  let flightPeak = 0
  for (let f = 1; f <= 144; f++) {
    z -= FLIGHT_SPEED / 72
    setPropClock(0.5 + (FRAMES + f) / 72)
    snapshot()
    walk.update(0, EYE, z)
    auditSwaps(getPropClock())
    retiringPeak = Math.max(retiringPeak, walk.retiring.length)
    flightPeak = Math.max(flightPeak, walk.fades.length)
    if (walk.placed + walk.fades.length + walk.retiring.length + walk.freeCount !== walk.maxInstances) flightLeaks++
    for (let k = 0; k < walk.fades.length; k++) if (walk.fadeAt[walk.fades[k].orig] !== k) flightOrphans++
  }
  check(flightPeak === TREE_TUNING.FADE_MAX_INFLIGHT,
    'flying fills the in-flight ceiling, and the swaps past it pop rather than throw',
    `${flightPeak} duplicates at ${FLIGHT_SPEED} m/s against a ceiling of ${TREE_TUNING.FADE_MAX_INFLIGHT}`)
  check(flightLeaks === 0 && flightOrphans === 0,
    'and the books still close at that speed',
    `${flightLeaks} frames out of balance, ${flightOrphans} orphaned entries`)
  check(modeSwaps.toClumps > 0,
    'flying leaves tiles behind across CLUMP_FROM, so this gate covers the singles-to-clump swap too',
    `${modeSwaps.toClumps} tiles swapped to clumps`)
  check(modeSwaps.oldCut === 0 && modeSwaps.newSnapped === 0,
    'a mode swap dithers rather than pops: every standing tree of the old population goes OUT through the rim and every shown tree of the new one comes IN',
    `${modeSwaps.oldCut} old trees cut, ${modeSwaps.newSnapped} new trees snapped, ${retiringPeak} retiring at the peak`)
  check(walk.swapCuts === 0,
    'and the pool carried both populations through every swap, so none was cut short for want of a slot',
    `${walk.swapCuts} swaps cut, ${walk.maxInstances - walk.freeCount} of ${walk.maxInstances} used at the end of the flight`)
  check(modeSwaps.oldOffClock === 0 && modeSwaps.newOffClock === 0,
    'and both halves of every swap are stamped off the same prop clock reading, so they dither complementarily',
    `${modeSwaps.oldOffClock} old and ${modeSwaps.newOffClock} new off the clock`)

  // And everything retires. The clock is advanced past the window with the
  // camera standing still, which is the state a player is in most of the time.
  for (let f = 0; f < 40; f++) {
    setPropClock(0.5 + (FRAMES + 144 + f) / 72)
    walk.update(0, EYE, z)
  }
  let stamped = 0
  for (const tile of walk.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      if (walk.batch.fade[tile.ids[k]] !== 1 && !walk.rim.isBusy(tile.ids[k])) stamped++
    }
  }
  check(walk.fades.length === 0 && walk.fadeTris === 0,
    'standing still for longer than the window leaves no duplicate and no ghost triangles',
    `${walk.fades.length} in flight, ${walk.fadeTris} triangles`)
  check(stamped === 0,
    'and every tree is back to the never-fade default, so no id carries a stale clock reading',
    `${stamped} still stamped`)
  check(walk.retiring.length === 0 && walk.retiringTris === 0,
    'and every retired population has drained back to the pool, so no swap holds two populations past the window',
    `${walk.retiring.length} retiring, ${walk.retiringTris} triangles`)
  check(walk.placed + walk.freeCount === walk.maxInstances,
    'and the pool is whole again',
    `${walk.placed} placed, ${walk.freeCount} free, ${walk.maxInstances} pool`)
}

// --- 9c. the shape of the cross-dissolve ramp -------------------------------
//
// WHAT THIS IS FOR. The ramp is material.js's, shared by every dissolve in the
// world: every rim fade, and the LOD cross-dissolves the forest, rocks, grass
// and ferns all run. It is gated here because this is where the
// shader's numbers are read. A cross-dissolve conserves coverage -- the two halves take
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
// NAME is one somebody can act on -- `oak`, not the bank index 2 -- and the
// pick VOLUME is the tree's own trunk
// and crown rather than a species constant. The second is what stopped the
// cursor pointing through a trunk at the fern behind it: a 3 m radius column
// from the ground up put the eye INSIDE the tree at any range you would inspect
// one from, and pick.js ranks a volume from inside by its far wall.

console.log('\n-- the cursor names a tree --')

{
  const names = trees.variantName
  check(names.length === trees.variantCount, 'every variant has a name', `${names.length} of ${trees.variantCount}`)
  check(names.every((n, i) => n === species[i]),
    'and the name is the species itself, not the bank index',
    names.join(' / '))
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
  // all of them, and a sapling is a third the size of its full-grown variant --
  // so a one-species forest still spreads by nearly the SCALE range.
  const scratchSize = { radius: 0, base: 0, rise: 0 }
  let widest = 0
  let narrowest = Infinity
  let n = 0
  let clumpVolume = 0
  for (const t of trees.tiles.values()) {
    for (let k = 0; k < t.n; k++) {
      trees.pickTrunkAt(t.ids[k], scratchSize)
      if (t.clumpy) {
        if (scratchSize.radius !== 0 || scratchSize.rise !== 0) clumpVolume++
        trees.pickCrownAt(t.ids[k], scratchSize)
        if (scratchSize.radius !== 0 || scratchSize.rise !== 0) clumpVolume++
        continue
      }
      widest = Math.max(widest, scratchSize.radius)
      narrowest = Math.min(narrowest, scratchSize.radius)
      n++
    }
  }
  check(widest < 3 && narrowest > 0.01 && widest / narrowest > (SCALE[1] / SCALE[0]) * 0.9,
    'and the volumes track the trees rather than being one number for the forest',
    `${n} trees, trunk pick radius ${narrowest.toFixed(3)} to ${widest.toFixed(3)} m, all under the 3 m the constant used`)
  check(clumpVolume === 0, 'and a clump card has no pick volume at all, since it names no one tree',
    `${clumpVolume} clump volumes with size`)
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

  // THE TREELINE IS A GRADIENT. Mean height and scale of the bed on flat ground
  // whose snow line sits `above` metres below it, so every candidate reads the
  // same point on the gradient; on the same seed the bed at 0 m above is the
  // reference bed exactly.
  const at = (above, opts = {}) => {
    const t = new Trees(new THREE.Scene(), { ...flat, snowLineAt: () => 60 - above }, dry, texArray, { seed: 7, radius: 200, ...opts })
    t.place(0, 0)
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const sc = new THREE.Vector3()
    let sum = 0
    for (const tile of t.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        t.batch.getMatrixAt(tile.ids[k], m)
        m.decompose(p, q, sc)
        sum += sc.y
      }
    }
    const out = { n: t.placed, scale: sum / Math.max(1, t.placed) }
    t.dispose()
    return out
  }
  const ref = at(-100)
  const mid = at(TREELINE.fade / 2)
  const high = at(TREELINE.fade)
  const higher = at((TREELINE.fade + TREELINE.top) / 2)
  check(ref.n === baseline, 'below the snow line the bed is the reference bed', `${ref.n} vs ${baseline}`)
  check(mid.n < ref.n * 0.8 && mid.n > ref.n * TREELINE.floor * 2,
    `halfway up the ${TREELINE.fade} m fade the wood has thinned but not to its floor`, `${mid.n} of ${ref.n}`)
  check(Math.abs(high.n / ref.n - TREELINE.floor) < 0.03 && high.n > 20,
    `at the top of the fade ${TREELINE.floor * 100}% of the trees still stand`, `${high.n} of ${ref.n}`)
  check(higher.n > 0 && higher.n < high.n,
    'and above that they thin on toward the summit rather than stopping', `${higher.n} at ${(TREELINE.fade + TREELINE.top) / 2} m`)
  check(Math.abs(high.scale / ref.scale - TREELINE.stunt) < 0.03,
    `and the trees up there are ${TREELINE.stunt}x the height`, `${high.scale.toFixed(2)} vs ${ref.scale.toFixed(2)}`)
  check(mid.scale < ref.scale && mid.scale > high.scale, 'stunting eases in with the thinning')

  // THE BIOME. A field that answers one cover value everywhere, so the bed reads
  // one point on the ramp; meadow keeps a few lone trees, forest is the
  // reference bed untouched and taller.
  const cover = (c) => at(-100, { biome: { coverAt: () => c } })
  const meadow = cover(0)
  const wood = cover(1)
  const between = cover((BIOME.ramp[0] + BIOME.ramp[1]) / 2)
  check(wood.n === baseline, 'full cover is the reference bed', `${wood.n} vs ${baseline}`)
  check(Math.abs(meadow.n / baseline - BIOME.meadowKeep) < 0.02 && meadow.n > 0,
    `a meadow keeps ${BIOME.meadowKeep * 100}% of its trees, not none`, `${meadow.n} of ${baseline}`)
  check(between.n > meadow.n * 3 && between.n < wood.n * 0.8, 'the ramp between is a sparser wood', `${between.n}`)
  check(Math.abs(meadow.scale / ref.scale - BIOME.scale[0]) < 0.03 && Math.abs(wood.scale / ref.scale - BIOME.scale[1]) < 0.03,
    `and the trees run ${BIOME.scale[0]}x tall in a meadow to ${BIOME.scale[1]}x in the wood`,
    `${meadow.scale.toFixed(2)} / ${wood.scale.toFixed(2)} vs ${ref.scale.toFixed(2)}`)
  {
    let threw = false
    try { new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200, biome: {} }) } catch { threw = true }
    check(threw, 'something passed as `biome` that cannot answer throws at construction')
  }

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

// --- 12. trees on top of rocks ----------------------------------------------

console.log('\n-- rocks under the trunk --')

{
  // A stone standing 4 m proud over a 6 m disc, and a stub instead of the real
  // `Rocks` so what is under test is the TREE's half of the contract: what it asks
  // for, where it applies the answer, and what it does everywhere else.
  const STONE = { x: 40, z: -55, r: 6, top: 64 }
  let asked = 0
  let minSizeSeen = Infinity
  const stone = {
    blockTopAt(x, z, minSize) {
      asked++
      minSizeSeen = Math.min(minSizeSeen, minSize)
      const dx = x - STONE.x
      const dz = z - STONE.z
      return dx * dx + dz * dz < STONE.r * STONE.r ? STONE.top : -Infinity
    },
  }
  const t = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200, rocks: stone })
  t.place(0, 0)

  let on = 0
  let off = 0
  let wrongOn = 0
  let wrongOff = 0
  for (const tile of t.tiles.values()) {
    // A clump card sinks CLUMP_SINK, not a trunk's sink, and stands on no stone.
    if (tile.clumpy) continue
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const dx = t.instX[id] - STONE.x
      const dz = t.instZ[id] - STONE.z
      const sunk = 60 - PLACEMENT.sink * t.instScale[id]
      if (dx * dx + dz * dz < STONE.r * STONE.r) {
        on++
        // Settled the sink into the STONE's top rather than the ground's, and the
        // stored lift is what `_reground` will re-add on the next chunk swap.
        if (Math.abs(t.instY[id] - STONE.top) > 1e-4) wrongOn++
        if (Math.abs(t.instLift[id] - (STONE.top - 60)) > 1e-4) wrongOn++
      } else {
        off++
        if (Math.abs(t.instY[id] - sunk) > 1e-4) wrongOff++
      }
    }
  }

  check(asked > 0 && on > 0, 'the trees ask the rocks about every trunk, and some of them land on stone',
    `${asked} asked, ${on} of ${on + off} inside the stone`)
  check(minSizeSeen === ROCK_STAND_MIN,
    'and they ask about stone over ROCK_STAND_MIN, so no tree is ever perched on a cobble',
    `asked at ${minSizeSeen} m`)
  check(wrongOn === 0, 'a tree over the stone stands on its top, with the lift stored for the reground',
    `${wrongOn} of ${on} off the stone`)
  check(wrongOff === 0, 'and a tree beside it is sunk into the ground exactly as before',
    `${wrongOff} of ${off} moved`)

  // THE OFFSET IS A CONSTANT, WHICH IS THE WHOLE REASON IT IS STORED. `_reground`
  // re-seats a tree on the chunk mesh that has just been built under it; the rock
  // was seated off the same data, so the gap between them does not change and the
  // reground must not re-ask. Raising the world by 5 m must raise a tree on stone
  // by 5 m and nothing else about it.
  const raised = { ...flat, scatterAt: (x, z, cell, out) => { out.h = 65; out.tan = 0; return out }, heightAt: () => 65 }
  t.field = raised
  const before = []
  for (const tile of t.tiles.values()) {
    for (let k = 0; k < tile.n; k++) before.push([tile.ids[k], t.instY[tile.ids[k]]])
  }
  for (const tile of t.tiles.values()) t._reground(tile)
  let moved = 0
  for (const [id, y] of before) if (Math.abs(t.instY[id] - y - 5) > 1e-4) moved++
  check(moved === 0, 'and a reground moves a tree on stone with the ground, without re-asking',
    `${moved} of ${before.length} did something else`)

  const bare = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200 })
  bare.place(0, 0)
  check(bare.placed === t.placed,
    'a rock lifts a tree and never deletes one -- the two beds are the same scatter',
    `${bare.placed} without rocks, ${t.placed} with`)

  let threw = false
  try {
    new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200, rocks: {} })
  } catch { threw = true }
  check(threw, 'and something passed as `rocks` that cannot answer throws at construction')

  t.dispose()
  bare.dispose()
}

// --- 13. trees off the dead wood --------------------------------------------

console.log('\n-- the dead wood under the trunk --')

{
  // The dead wood is placed first and the trees keep off it: every candidate
  // asks `occupiesAt(x, z, pad)` with its own trunk radius plus
  // DEADWOOD_CLEARANCE and is refused where the answer is yes. A stub in place
  // of the real Deadwood, so what is under test is the TREE's half: a log as a
  // 20 m segment across the scatter and a stump as a disc, both wide enough to
  // sit in the way of many trunks.
  const PIECES = [
    { x: -30, z: 20, ax: Math.SQRT1_2, az: Math.SQRT1_2, half: 10, r: 1 },
    { x: 45, z: -40, ax: 0, az: 0, half: 0, r: 3 },
  ]
  const clearance = (p, x, z) => {
    let dx = x - p.x
    let dz = z - p.z
    let t = dx * p.ax + dz * p.az
    t = t < -p.half ? -p.half : t > p.half ? p.half : t
    dx -= p.ax * t
    dz -= p.az * t
    return Math.hypot(dx, dz) - p.r
  }
  let asked = 0
  const deadwood = {
    occupiesAt(x, z, pad) {
      asked++
      return PIECES.some((p) => clearance(p, x, z) < pad)
    },
  }
  const t = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200, deadwood })
  t.place(0, 0)
  const bare = new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200 })
  bare.place(0, 0)

  // Every placed trunk, surface to surface off the nearest piece, and the
  // bare scatter's trunks sorted into the ones that stood in the way and the
  // ones that did not.
  const trunks = (trees) => {
    const out = []
    for (const tile of trees.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        out.push([trees.instX[id], trees.instZ[id], trees.unitTrunkRadius[trees.variantAt[id]] * trees.instScale[id]])
      }
    }
    return out
  }
  const gap = ([x, z, r]) => Math.min(...PIECES.map((p) => clearance(p, x, z))) - r
  const kept = trunks(t)
  const inWay = trunks(bare).filter((tr) => gap(tr) < TREE_TUNING.DEADWOOD_CLEARANCE)
  const clear = trunks(bare).filter((tr) => gap(tr) >= TREE_TUNING.DEADWOOD_CLEARANCE)
  const through = kept.filter((tr) => gap(tr) < TREE_TUNING.DEADWOOD_CLEARANCE)
  const key = ([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`
  const keptKeys = new Set(kept.map(key))
  const lost = clear.filter((tr) => !keptKeys.has(key(tr)))

  check(asked > 0 && inWay.length > 5, 'the trees ask the dead wood about every trunk, and some of them stood in its way',
    `${asked} asked, ${inWay.length} of ${inWay.length + clear.length} bare trunks within a metre of a piece`)
  check(through.length === 0, 'no trunk stands within a metre of a log or a stump, surface to surface',
    through.length === 0 ? `${kept.length} trunks all clear` : `${through.length} through the wood`)
  check(t.placed === bare.placed - inWay.length && lost.length === 0,
    'and the trees off the wood are exactly the bare scatter\'s',
    `${t.placed} with the dead wood, ${bare.placed} without, ${inWay.length} refused, ${lost.length} moved`)

  let threw = false
  try {
    new Trees(new THREE.Scene(), flat, dry, texArray, { seed: 7, radius: 200, deadwood: {} })
  } catch { threw = true }
  check(threw, 'and something passed as `deadwood` that cannot answer throws at construction')

  t.dispose()
  bare.dispose()
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all tree checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
