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
//   THE TWO MESH TIERS STOP BEING THE SAME TREE. treeLod(p, 1) changes only how
//   the crown is DRAWN -- trunkSides, branchSides, a bundle of blades thrown
//   through the crown instead of a card per spray -- and leaves every count and
//   size alone, so buildTree walks an identical rng stream and lays out an
//   identical tree. That is what makes the 10 m swap invisible. The moment a
//   count moves, the crown moves with it: the note this replaced records aspen's
//   LOD1 crown coming out 45% wider than its LOD0 one, which reads as every
//   distant tree inflating as you walk away from it. Nothing throws. So the
//   tiers are compared VERTEX BY VERTEX here rather than argued from the
//   parameters.
//
//   THE TRIANGLE LAW DRIFTS AWAY FROM THE BUILDER. resolveTree is the one place
//   the law lives, the previewer's budget panel prints it, and the bank sizes
//   itself from it -- so if it disagrees with what buildTree actually emits, the
//   forest costs a different number of triangles than every report about it
//   says. The law is re-derived here from its own docblock and checked against
//   the INDEX COUNT of the built geometry, at both tiers, for every species.
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
//   THE BANDS STOP NESTING IN THE BANK. LOD_BANDS has to have exactly one entry
//   per tier boundary; one too few and the last tier is unreachable, one too
//   many and update() indexes past the ladder. Same shape of check as the
//   grass's, and the same silent failure.
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

import * as THREE from 'three'

import {
  TREE_DEFAULTS, TREE_SPECIES, treeLod, resolveTree, buildTree,
} from '../src/props/tree.js'
import { TREE_SIZES, buildTreeBank, treeVariants, treeImpostorLayers } from '../src/props/tree-bank.js'
import { buildImpostorCard } from '../src/props/impostor.js'
import { CARD_UP_MARK } from '../src/material.js'
import { Trees, TREE_TUNING } from '../src/v2/render/trees.js'
import { GRASS_TUNING } from '../src/v2/render/grass.js'
import { LAYER_COUNT, buildTextureArray } from '../src/textures.js'

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
    const branch = r.limbs * limb(p.branchSides, p.branchRings)
    const foliage = r.bundleTris > 0
      ? r.bundleTris
      : (r.limbs * r.sprays + r.apexSprays) * r.cardTris
    return trunk + branch + foliage
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

    check(r0.bundleTris === 0, `${s} LOD0 draws its crown as one card per spray`,
      `bundleTris ${r0.bundleTris}, ${r0.sprayTris} card triangles`)
    check(r1.bundleTris === 20, `${s} LOD1 draws its crown as twenty blades`,
      `bundleTris ${r1.bundleTris}`)
    check(lawTris(p0, r0) === r0.triangles && r0.triangles === a0,
      `${s} LOD0 builds exactly the triangles the law predicts`,
      `law ${lawTris(p0, r0)}, resolveTree ${r0.triangles}, built ${a0}`)
    check(lawTris(p1, r1) === r1.triangles && r1.triangles === a1,
      `${s} LOD1 builds exactly the triangles the law predicts`,
      `law ${lawTris(p1, r1)}, resolveTree ${r1.triangles}, built ${a1}`)
    // The shape of the LOD1 bill, spelled out: a 3-sided trunk, one fin per
    // limb, and the bundle -- which is a flat budget rather than a count derived
    // from the crown, so it is the same 20 on every species and every size. If
    // any of the three grows a term the tier has stopped being the cheap one.
    check(r1.triangles === r1.trunkTris + r1.limbs + r1.sprayTris
      && r1.trunkTris === 3 && r1.sprayTris === 20,
      `${s} LOD1 costs trunk 3 + one fin per limb + a 20-blade bundle`,
      `3 + ${r1.limbs} + ${r1.sprayTris} = ${r1.triangles}`)
    // The bundle is a fixed 20 while LOD0 grows with the crown, so the ratio is
    // not one number -- it runs 6.9x on a small birch to 12.5x on a big oak.
    // Gated as a band wide enough to hold that and narrow enough that a tier
    // which stopped being the cheap one falls out of it.
    check(a0 / a1 > 6 && a0 / a1 < 14, `${s} LOD1 is between six and fourteen times cheaper than LOD0`,
      `${a0} -> ${a1}, ${(a0 / a1).toFixed(2)}x`)

    // Same number at both tiers by construction: at LOD1 it is the TILE size on
    // the blades rather than a card's height, which is what lets the bundle keep
    // the rule that a spray is a fixed size in the world.
    check(r0.sprayMetres === r1.sprayMetres, `${s} asks for the same spray size at both tiers`,
      `${r0.sprayMetres} m, built ${g0.userData.tree.sprayMetres.toFixed(4)} / ` +
      `${g1.userData.tree.sprayMetres.toFixed(4)} m after the rescale`)

    g0.dispose()
    g1.dispose()
  }
}

// --- 2. the two mesh tiers nest ---------------------------------------------
//
// The strong form of the claim in tree-bank.js's header. LOD1 with its bundle
// switched back off must be the SAME TREE as LOD0 -- not a similar one, not one
// within a tolerance -- because treeLod moves nothing that feeds the layout and
// buildTree is deterministic in its seed. Foliage only: the trunk and branches
// legitimately differ, since that is the whole of what the tier changes.
//
// Positions are divided by userData.tree.height before they are compared. The
// rescale loop drives both builds to the requested height so the ratio is 1 in
// practice, but a tier that quietly came out at a different size would show up
// as a shape difference rather than as an offset, which is the harder failure
// to see.

console.log('\n-- the two mesh tiers nest --')

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
      // treeLod's ONLY foliage change, undone. What is left is the trunk and
      // branch coarsening, which cannot touch a leaf.
      const g1 = buildTree({ ...treeLod(p, 1), bundleTris: 0 })
      const a = foliage(g0, p.leafLayer)
      const b = foliage(g1, p.leafLayer)
      verts = a.length / 3
      if (a.length !== b.length) { counts = false; break }
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      g0.dispose()
      g1.dispose()
    }
    check(counts && verts > 0 && worst === 0,
      `${s} lays out an identical crown at both tiers, over 8 seeds`,
      `${verts} foliage vertices, worst drift ${worst.toExponential(1)} of a tree height`)
  }
}

// --- 3. crown and height parity ---------------------------------------------
//
// What the nesting buys, measured the way the bank consumes it: tree-bank.js
// frames BOTH card tiers on tier 0's crownWidth and tier 0's height and never
// measures tier 1, so the two have to agree or a tree changes size at the 45 m
// band. HEIGHT is exact and gated as exact -- both tiers are driven to the
// requested height by the same rescale loop, so anything but zero there is a
// tier that stopped nesting. WIDTH cannot be exact, because the bundle does not
// wrap the crown, it samples it: 20 blades are 60 corners against a crown of
// hundreds of sprays, so the outermost spray is usually not one of the 60 and
// LOD1 comes out slightly NARROW. That is the honest direction to miss in --
// a distant tree a touch small reads as distance, one inflating as you walk
// away reads as a bug.
//
// THE TOLERANCE, and why it is two numbers rather than one. The mean is gated
// and the spread is printed, because a single seed can disagree by a good deal
// more than the mean. Broadleaves are held to 4%: they sit at -1.1% (oak),
// -2.6% (birch) and -0.1% (aspen) today, and the regressions that actually move
// this number blow straight through it -- dropping bundleSpread to 0, so each
// corner stops at the card seat instead of being pushed past it, takes birch to
// -12% and aspen to -9%, and halving the blade count takes every broadleaf past
// -9%. Pine is held to 8% and sits at -6.1%: its crown carries by far the most
// sprays, so 60 corners sample it worst, and that is a fact about the species
// rather than a slack allowance -- see bundleSpread's own note in tree.js.

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
  const mean = d.reduce((a, b) => a + b, 0) / d.length
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length)
  const tol = s === 'pine' ? 0.08 : 0.04
  check(Math.abs(mean) < tol, `${s} LOD1 crowns average within ${tol * 100}% of LOD0's`,
    `mean ${mean >= 0 ? '+' : ''}${pct(mean)}, sd ${pct(sd)}, n=${d.length}`)
  check(worstHeight === 0, `${s} stands exactly as tall at LOD1 as at LOD0`,
    `worst ${pct(worstHeight)} over ${d.length} builds`)
}

// --- 4. the bank ------------------------------------------------------------

console.log('\n-- bank --')

const bank = buildTreeBank({ seed: 1, billboard: true })
const variants = treeVariants()

{
  check(bank.variants.length === species.length * TREE_SIZES.length,
    'the bank is exactly species x size', `${species.length} x ${TREE_SIZES.length} = ${bank.variants.length}`)
  check(bank.tiers.every((t) => t.geometries.length === bank.variants.length),
    'every tier holds one geometry per variant',
    bank.tiers.map((t) => t.geometries.length).join(' / '))

  // The same relationship the grass gate holds, and the same failure: one band
  // too few leaves the last tier unreachable, one too many walks off the end of
  // the ladder in update().
  check(LOD_BANDS.length === bank.tiers.length - 1,
    'one band per tier boundary',
    `${LOD_BANDS.length} bands, ${bank.tiers.length} tiers`)

  // Strictly cheaper at every step, across the WHOLE variant set rather than
  // per variant: a ladder whose rungs overlap has a band that costs more the
  // further away it is drawn.
  const lo = bank.tiers.map((t) => Math.min(...t.triangles))
  const hi = bank.tiers.map((t) => Math.max(...t.triangles))
  let descends = true
  for (let t = 1; t < bank.tiers.length; t++) if (hi[t] >= lo[t - 1]) descends = false
  check(descends, 'every tier is cheaper than every variant of the tier before it',
    bank.tiers.map((t, i) => `${lo[i]}-${hi[i]}`).join(' | '))
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

// --- 5. the bands -----------------------------------------------------------

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
  // the mesh tiers have to reach past the thinning or a tree at 90 m is a
  // billboard while its neighbour at 79 m is a mesh -- so the violation is
  // recorded rather than gated.
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

// --- 6. the vertical squash -------------------------------------------------
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
  const EYE_OVER_ROOT = 2
  let inert = true
  const perBand = []
  for (const b of LOD_BANDS) {
    const plain = Math.sqrt(Math.max(0, b * b - EYE_OVER_ROOT ** 2))
    const squashed = Math.sqrt(Math.max(0, b * b - (EYE_OVER_ROOT * Y_SQUASH) ** 2))
    const grew = squashed / plain - 1
    if (grew >= 0.02) inert = false
    perBand.push(`${b} m: ${plain.toFixed(3)} -> ${squashed.toFixed(3)} m, +${pct(grew)}`)
  }
  check(inert, `at ${EYE_OVER_ROOT} m of eye height the squash widens every band by under 2%`,
    perBand.join('; '))

  // (c) WHAT IT IS FOR. A canopy 9 m up, seen from 8 m out along the ground, is
  // an arm's length away and has to be a mesh. Without the squash it is not.
  const CANOPY = 9
  const OUT = 8
  check(tierOf(OUT, CANOPY, true) === 0 && tierOf(OUT, CANOPY, false) > 0,
    `a canopy ${CANOPY} m up and ${OUT} m out resolves to the finest tier only under the squash`,
    `tier ${tierOf(OUT, CANOPY, false)} -> ${tierOf(OUT, CANOPY, true)}`)
  const reach = (squash) => Math.sqrt(Math.max(0, bandSq[0] - (CANOPY * (squash ? Y_SQUASH : 1)) ** 2))
  note(`tier-0 horizontal reach at ${CANOPY} m of height`,
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

// --- 7. the scatter ---------------------------------------------------------
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

trees.dispose()

// --- 8. placement -----------------------------------------------------------

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
