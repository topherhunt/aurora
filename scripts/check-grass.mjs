// Node-side gates for the grass carpet (src/props/grass-bank.js,
// src/v2/render/grass.js, DESIGN.md §5).
//
//   node scripts/check-grass.mjs
//
// Grass is the densest thing in the world by a factor of sixty, and that is
// what makes it worth a check file of its own: every one of the failures below
// is invisible in a screenshot of a single tuft and obvious across 23,000 of
// them. In the order they cost the most:
//
//   THE BILLBOARD LIST STOPS BEING EXACTLY THE CARD LAYER. Billboarding is
//   selected BY TEXTURE LAYER against a uniform list compiled into the shader,
//   so putting GRASS_TUFT on that list would spin the 3-plane and 2-plane
//   crossed quads as well -- every near tuft collapsing to a single flat sheet
//   that turns with the head. It cannot throw and it does not look like a bug
//   in a still. This is the reason IMPOSTOR_GRASS exists as a separate layer at
//   all, so it is checked first.
//
//   THE ATTRIBUTE LAYOUT DRIFTS. BatchedMesh validates that every geometry in
//   the batch has an identical layout and refuses the whole mesh over one stray
//   `uv`, so this is a boot failure for the entire grass batch.
//
//   THE THINNING LAW STOPS HOLDING. "Twice the distance, half the density" is
//   what makes a 70 m carpet 23k instances instead of 46k, and it is spread
//   across a quantised level table, a per-tile nearest-corner distance and a
//   per-candidate rank compared against a keep-fraction. Any of those three
//   drifting gives a carpet that is merely thinner or merely more expensive,
//   and neither reads as wrong. So the law is measured on the placed instances
//   rather than argued from the constants.
//
//   THE FADE STOPS COVERING THE CULL. Every tuft carries the distance at which
//   it dissolves, and if that number is ever SHORTER than where the tuft
//   actually stands, the tuft is invisible; if it is longer than the draw
//   radius, the tuft pops at the rim instead of fading. Both are one line in
//   _growTile and both are silent.
//
//   THE VARIATION STOPS BEING VARIED. The range is 0.5 m to 1.5 m and a tint
//   that moves. A stuck random, a clamp in the wrong place or a tint applied in
//   sRGB instead of linear all produce a carpet that renders perfectly and
//   looks like one cloned plant.
//
//   THE TUFT ART GOES MISSING OR STOPS BEING NEUTRAL. GRASS_TUFT is greyscale
//   on purpose -- it is multiplied by the whole of the instance tint, so a
//   green cast in the PNG would be applied twice -- and it is a runtime file
//   outside public/props, which `npm run props --clean` deletes.

import * as THREE from 'three'

import {
  buildGrassBank, bakeGrassImpostor, grassBillboardLayers, GRASS_TIERS, GRASS_BASE, TUFT_TWIST,
  buildGrassStripBank, stripTiles, STRIP_BASE,
} from '../src/props/grass-bank.js'
import { Grass, GRASS_TUNING } from '../src/v2/render/grass.js'
import {
  LAYER, LAYER_COUNT, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, buildTextureArray,
  shapeImageLayer, GRASS_FRAY_TUNING,
} from '../src/textures.js'
import { stripCoverage, getStripTiling } from '../src/material.js'
import { impostorCardExtents } from '../src/props/impostor.js'
import { readPng } from '../tools/props/png.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

const { DENSITY, FULL_RADIUS, DRAW_RADIUS, LOD_BANDS, VEIL_PHASES, TILE, HEIGHT, PLACEMENT,
  STRIP_DENSITY, STRIP_HEIGHT, STRIP_TILES, STRIP_SINK } = GRASS_TUNING

// --- 1. the bank ------------------------------------------------------------

console.log('\n-- bank --')

const bank = buildGrassBank()

check(bank.tiers.length === 3, 'three tiers', bank.tiers.map((t) => t.name).join(' '))
check(
  bank.tiers.map((t) => t.planes).join(',') === '3,2,1',
  'planes go 3, 2, 1',
  bank.tiers.map((t) => t.planes).join(',')
)
check(
  bank.tiers.map((t) => t.triangles).join(',') === '6,4,2',
  'triangles go 6, 4, 2',
  `${bank.tiers.reduce((n, t) => n + t.triangles, 0)} in the whole ladder`
)
// The card MUST be last: render/grass.js indexes LOD_BANDS against tier order
// and throws if it is not, but the throw is at construction on the route, and
// here it is one line.
check(bank.cardTier === bank.tiers.length - 1, 'the billboard is the coarsest tier')
check(
  LOD_BANDS.length === bank.tiers.length - 1,
  'one band per tier boundary',
  `${LOD_BANDS.length} bands, ${bank.tiers.length} tiers`
)

// THE ONE THAT MATTERS. Mesh tiers on the tuft layer, the card alone on the
// impostor layer, and the billboard list naming that layer and nothing else.
const meshLayers = bank.tiers.filter((t) => !t.billboard).map((t) => t.layer)
const bb = grassBillboardLayers()
check(meshLayers.every((l) => l === LAYER.GRASS_TUFT), 'mesh tiers wear GRASS_TUFT')
check(bank.tiers[bank.cardTier].layer === LAYER.IMPOSTOR_GRASS, 'the card wears IMPOSTOR_GRASS')
check(
  bb.length === 1 && bb[0] === LAYER.IMPOSTOR_GRASS,
  'the billboard list is exactly the card layer',
  `[${bb.join(', ')}]`
)
check(!bb.includes(LAYER.GRASS_TUFT), 'GRASS_TUFT is NOT billboarded -- the mesh tuft stays put')

// Attribute layout: identical across the ladder, and exactly what the shared
// prop batch's arena holds.
const WANT = ['position', 'normal', 'uvProj', 'texLayer']
for (const t of bank.tiers) {
  const got = Object.keys(t.geometry.attributes).sort()
  check(
    got.join(',') === [...WANT].sort().join(','),
    `${t.name}: attributes are ${WANT.join(' + ')}`,
    got.join(',')
  )
  check(t.geometry.index !== null, `${t.name}: indexed`)
}

// Every normal vertical. See buildGrassTuft in grass-bank.js: a horizontal
// normal on the card twinkles as the player turns, and a mesh tier that
// disagrees with the card changes brightness at the 20 m boundary where
// thousands of tufts sit.
for (const t of bank.tiers) {
  const n = t.geometry.attributes.normal
  let vertical = true
  for (let i = 0; i < n.count; i++) {
    if (Math.abs(n.getY(i) - 1) > 1e-5 || Math.abs(n.getX(i)) > 1e-5 || Math.abs(n.getZ(i)) > 1e-5) {
      vertical = false
    }
  }
  check(vertical, `${t.name}: every normal is +Y`)
}

// Seated on the ground and framed correctly. The card is inflated by the
// impostor margin and the mesh tiers are NOT -- feed `ext` to a mesh tier and
// the tuft art stretches 12%, which is the bug this pins.
//
// Framing is checked on the FOOTPRINT CIRCLE rather than on max|x|, because
// that is the invariant the bake actually needs and it is the one the twist
// preserves: a rotation about the tuft's axis cannot move a vertex off its own
// circle, so the subject fits the ortho frame at any twist and from any
// azimuth. max|x| would be the same number only on the old asterisk.
const ext = impostorCardExtents(GRASS_BASE)
for (const t of bank.tiers) {
  const p = t.geometry.attributes.position
  let minY = Infinity
  let maxY = -Infinity
  let maxR = 0
  for (let i = 0; i < p.count; i++) {
    minY = Math.min(minY, p.getY(i))
    maxY = Math.max(maxY, p.getY(i))
    maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)))
  }
  const want = t.billboard ? ext : GRASS_BASE
  check(near(minY, 0, 1e-5), `${t.name}: seated at y = 0`, minY.toFixed(4))
  check(near(maxY, want.height, 1e-4), `${t.name}: ${want.height.toFixed(3)} m tall`, maxY.toFixed(4))
  check(near(maxR * 2, want.width, 1e-4), `${t.name}: fills a ${want.width.toFixed(3)} m circle`,
    (maxR * 2).toFixed(4))
}
check(ext.width > GRASS_BASE.width, 'the card is wider than the tuft it replaces',
  `${ext.width.toFixed(3)} vs ${GRASS_BASE.width}`)

// THE TUFT IS A TRIANGLE, NOT AN ASTERISK. The distinguishing fact is that no
// card touches the tuft's axis: on the asterisk every plane ran through it, so
// half of all vertices sat at radius 0. Here every base vertex is a corner of
// the polygon, so all of them sit on the rim.
{
  const lod0 = bank.tiers[0].geometry
  const p = lod0.attributes.position
  let onAxis = 0
  let onRim = 0
  const baseCorners = []
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getZ(i))
    if (r < 1e-4) onAxis++
    if (near(r, GRASS_BASE.width / 2, 1e-4)) onRim++
    if (Math.abs(p.getY(i)) < 1e-5) baseCorners.push([p.getX(i), p.getZ(i)])
  }
  check(onAxis === 0, 'LOD0: no card passes through the tuft axis', `${onAxis} vertices at r = 0`)
  check(onRim === p.count, 'LOD0: every vertex sits on the footprint circle', `${onRim}/${p.count}`)

  // Base to base: the six base vertices are three COINCIDENT PAIRS, because
  // each card ends where the next one starts. An asterisk would give six
  // distinct points, and three cards merely spread apart would too.
  check(baseCorners.length === 6, 'LOD0: six base vertices', `${baseCorners.length}`)
  let joins = 0
  for (let i = 0; i < baseCorners.length; i++) {
    for (let j = i + 1; j < baseCorners.length; j++) {
      if (Math.hypot(baseCorners[i][0] - baseCorners[j][0],
        baseCorners[i][1] - baseCorners[j][1]) < 1e-5) joins++
    }
  }
  check(joins === 3, 'LOD0: the three cards join base to base, closing a triangle',
    `${joins} shared corners`)

  // Each card is a chord of the circle, so sqrt(3)/2 of the footprint.
  const side = Math.hypot(baseCorners[0][0] - baseCorners[1][0], baseCorners[0][1] - baseCorners[1][1])
  check(near(side, (GRASS_BASE.width / 2) * Math.sqrt(3), 1e-4),
    'LOD0: each card is the triangle side, 0.476 m', side.toFixed(4))
}

// THE TWIST, on the mesh tiers and NOT on the card. Measured as the angle
// between a base vertex and the top vertex above it, about the tuft's axis --
// which is exactly what buildGrassTuft claims to have done to it.
check(TUFT_TWIST >= (10 * Math.PI) / 180 && TUFT_TWIST <= (30 * Math.PI) / 180,
  'the twist is in the 10-30 degree band',
  `${((TUFT_TWIST * 180) / Math.PI).toFixed(1)} deg`)
for (const t of bank.tiers) {
  const p = t.geometry.attributes.position
  const want = t.billboard ? 0 : TUFT_TWIST
  let worst = 0
  // Corners are pushed base-a, base-b, top-b, top-a, so vertex k pairs with
  // k + 3 and k + 1 with k + 2 within every quad.
  for (let q = 0; q < p.count; q += 4) {
    for (const [lo, hi] of [[0, 3], [1, 2]]) {
      const a = Math.atan2(p.getZ(q + lo), p.getX(q + lo))
      const b = Math.atan2(p.getZ(q + hi), p.getX(q + hi))
      let d = b - a
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      worst = Math.max(worst, Math.abs(d - want))
    }
  }
  check(worst < 1e-5,
    t.billboard
      ? `${t.name}: NOT twisted -- the twist is already in the photograph`
      : `${t.name}: top edge turned ${((want * 180) / Math.PI).toFixed(0)} deg from the base`,
    `off by ${((worst * 180) / Math.PI).toFixed(4)} deg`)
}

check(bank.bytes < 8 * 1024, 'the whole bank is under 8 KB', `${(bank.bytes / 1024).toFixed(2)} KB`)

// --- 2. layers and the tuft art ---------------------------------------------

console.log('\n-- layers --')

check(LAYER.GRASS_TUFT < LAYER_COUNT && LAYER.IMPOSTOR_GRASS < LAYER_COUNT, 'both layers are inside LAYER_COUNT')
check(LAYER.GRASS_TUFT !== LAYER.IMPOSTOR_GRASS, 'the tuft and its impostor are different layers')
check(IMAGE_LAYERS[LAYER.GRASS_TUFT] === 'grass/grass_tuft.png', 'GRASS_TUFT loads from public/grass',
  String(IMAGE_LAYERS[LAYER.GRASS_TUFT]))
// Deliberately absent: the impostor is photographed at load by bakeCards, so a
// file mapping here would overwrite the bake with a blank on the next load.
check(IMAGE_LAYERS[LAYER.IMPOSTOR_GRASS] === undefined, 'IMPOSTOR_GRASS has no file -- it is baked at load')
// Snow settles on the GROUND grass grows out of, not on the blades: a white cap
// on a 4-triangle tuft is a white rectangle.
check(!SNOW_LAYERS.includes(LAYER.GRASS_TUFT), 'no snow on the tuft layer')
check(!SNOW_LAYERS.includes(LAYER.IMPOSTOR_GRASS), 'no snow on the grass impostor')

const png = readPng(new URL('../public/grass/grass_tuft.png', import.meta.url).pathname)
check(png.width === TEX_SIZE && png.height === TEX_SIZE, `the tuft PNG is ${TEX_SIZE}^2`,
  `${png.width}x${png.height}`)
{
  let opaque = 0
  let sum = 0
  let chroma = 0
  for (let i = 0; i < png.width * png.height; i++) {
    const r = png.data[i * 4]
    const g = png.data[i * 4 + 1]
    const b = png.data[i * 4 + 2]
    if (png.data[i * 4 + 3] > 127) {
      opaque++
      sum += (r + g + b) / 3
      chroma += Math.max(r, g, b) - Math.min(r, g, b)
    }
  }
  const cover = opaque / (png.width * png.height)
  check(cover > 0.1 && cover < 0.4, 'the tuft covers 10-40% of its layer', `${(cover * 100).toFixed(1)}%`)
  // GREYSCALE, and this is load-bearing rather than incidental: the instance
  // tint is the entire colour of the grass, so a green cast here is applied on
  // top of a green tint and the carpet goes fluorescent.
  check(chroma / opaque < 2, 'the tuft is greyscale', `mean chroma ${(chroma / opaque).toFixed(2)}/255`)
  check(sum / opaque > 100 && sum / opaque < 190, 'the tuft is mid-grey, so a tint has room both ways',
    `mean ${(sum / opaque).toFixed(0)}/255`)
}

// --- 2b. the frayed foot ----------------------------------------------------
//
// GRASS_TUFT does not reach the array as the file has it: textures.js eats the
// foot of the picture away so the carpet does not stand on one straight dark
// line (see LAYER_SHAPERS there for the whole argument). Every failure below is
// a fray that renders perfectly and is not doing its job:
//
//   IT STOPS REACHING ABOVE THE GROUND. render/grass.js buries the bottom
//   PLACEMENT.sink / GRASS_BASE.height of every card, so a fray that only bites
//   below that line is work done underground and the hem is still there.
//
//   IT EATS THE FOOT OFF. The other end of the same knob: a tuft whose base is
//   gone floats above the terrain, which is worse than the line it replaced.
//
//   IT COLLAPSES BACK TO A LINE. The fray is only a fray because the columns
//   are cut at DIFFERENT heights; drop the rank-normalisation in frayColumnCut
//   and the cut heights pile up around their mean, which is a slightly fuzzy
//   straight edge -- measured, the foot goes from 12 distinct heights and 4.1
//   texels of spread to 5 and 1.4, and 41 of the 58 ground-row columns go back
//   on the ground instead of 33.
//
//   IT STOPS PREFERRING THE DARK. Eating the shadowed mass at the base is the
//   point -- a fray that took the lit blades instead would thin the tuft
//   without touching the line. Gated twice: once over the whole band, and once
//   at the ground row on its own, because that row is the line the player sees
//   and it is the row where a picture-wide brightness window fails (the band
//   darkens as it descends, so nothing at the bottom clears a global threshold
//   and the fray shortens the card rather than opening it -- see GRASS_FRAY.pct).

console.log('\n-- the frayed foot --')

{
  const N = TEX_SIZE
  const frayed = shapeImageLayer(LAYER.GRASS_TUFT, Uint8Array.from(png.data))
  const alpha = (px, x, y) => px[(y * N + x) * 4 + 3] > 127
  const lum = (px, x, y) => {
    const i = (y * N + x) * 4
    return (px[i] + px[i + 1] + px[i + 2]) / 3
  }

  check(frayed !== png.data, 'GRASS_TUFT has a shaper -- the layer is not the file')

  const top = Math.floor(GRASS_FRAY_TUNING.top * N)
  let above = 0
  for (let y = 0; y < top; y++) {
    for (let x = 0; x < N; x++) if (alpha(png.data, x, y) !== alpha(frayed, x, y)) above++
  }
  check(above === 0, 'nothing above the fray band is touched', `${above} texels differ`)

  // Where the terrain cuts the card, from render/grass.js's own numbers rather
  // than from a copy of them -- this is the pair that has to stay in step.
  const buried = GRASS_TUNING.PLACEMENT.sink / GRASS_BASE.height
  const groundRow = Math.round((1 - buried) * N)
  check(GRASS_FRAY_TUNING.top < 1 - buried, 'the fray starts above the line the terrain cuts',
    `top ${GRASS_FRAY_TUNING.top} vs ground ${(1 - buried).toFixed(3)}`)

  let wasGround = 0
  let isGround = 0
  for (let x = 0; x < N; x++) {
    if (alpha(png.data, x, groundRow)) wasGround++
    if (alpha(frayed, x, groundRow)) isGround++
  }
  const kept = isGround / wasGround
  check(kept > 0.35 && kept < 0.8, 'the row the terrain cuts is broken open but still standing',
    `${isGround} of ${wasGround} texels kept (${(kept * 100).toFixed(0)}%)`)

  // The VISIBLE foot: the lowest surviving row of each column that had grass at
  // the ground row, clamped there because anything under it is buried. Before
  // the fray every one of those columns reaches the ground and the foot is a row
  // of one number -- which is the line this whole section exists to break. Both
  // a COUNT of distinct heights and a spread, because they fail differently: a
  // few columns cut very deep would pass a variance while leaving the hem, and
  // many columns cut one texel apart would pass a count while doing nothing.
  const foot = []
  for (let x = 0; x < N; x++) {
    if (!alpha(png.data, x, groundRow)) continue
    let low = -1
    for (let y = top; y < N; y++) if (alpha(frayed, x, y)) low = y
    foot.push(Math.min(low, groundRow))
  }
  const levels = new Set(foot).size
  const mean = foot.reduce((a, b) => a + b, 0) / foot.length
  const spread = Math.sqrt(foot.reduce((a, b) => a + (b - mean) ** 2, 0) / foot.length)
  check(levels >= 8 && spread > 2.5, 'the foot ends at a spread of heights, not one',
    `${levels} levels over ${foot.length} columns, ${spread.toFixed(2)} texels of spread`)

  // Darkest first. Compared inside the band only, so this measures the fray's
  // preference and not the fact that the band is darker than the blade tips.
  let eatenSum = 0
  let eatenN = 0
  let keptSum = 0
  let keptN = 0
  for (let y = top; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!alpha(png.data, x, y)) continue
      if (alpha(frayed, x, y)) { keptSum += lum(png.data, x, y); keptN++ }
      else { eatenSum += lum(png.data, x, y); eatenN++ }
    }
  }
  check(eatenN > 0 && eatenSum / eatenN < keptSum / keptN - 5,
    'what it eats is darker than what it leaves',
    `eaten ${(eatenSum / eatenN).toFixed(0)}/255 vs kept ${(keptSum / keptN).toFixed(0)}/255`)

  // And the same question asked of the ONE row that decides the look. What has
  // to survive at the ground line is the lit blades, standing on it; what has to
  // go is the shadow between them. A fray that took these in the other order
  // would still pass the band-wide test above by eating dark texels higher up.
  let gEaten = 0
  let gEatenN = 0
  let gKept = 0
  let gKeptN = 0
  for (let x = 0; x < N; x++) {
    if (!alpha(png.data, x, groundRow)) continue
    if (alpha(frayed, x, groundRow)) { gKept += lum(png.data, x, groundRow); gKeptN++ }
    else { gEaten += lum(png.data, x, groundRow); gEatenN++ }
  }
  check(gEatenN > 0 && gKeptN > 0 && gEaten / gEatenN < gKept / gKeptN - 5,
    'at the ground line it is the lit blades that keep their footing',
    `kept ${(gKept / gKeptN).toFixed(0)}/255 vs eaten ${(gEaten / gEatenN).toFixed(0)}/255`)

  // Mip generation averages RGB without regard to alpha, so an eaten texel that
  // kept its dark colour bleeds the removed line back one mip down.
  let dark = 0
  for (let i = 0; i < N * N; i++) {
    if (frayed[i * 4 + 3] < 128 && Math.min(frayed[i * 4], frayed[i * 4 + 1], frayed[i * 4 + 2]) < 250) dark++
  }
  check(dark === 0, 'every eaten texel is flooded white, so no mip bleeds the line back', `${dark} left dark`)
}

// --- 3. the scatter ---------------------------------------------------------
//
// A real Grass on a flat, dry, path-free, snow-free world, so that NOTHING is
// rejected and every count below is the scatter's own arithmetic rather than
// the terrain's. The placement exclusions are checked separately, after.

console.log('\n-- scatter --')

const flat = {
  heightAndSlopeAt: () => ({ h: 60, tan: 0 }),
  // Strips sample their two ends through this to roll onto the slope; on flat
  // ground it is the same 60 the tufts get.
  heightAt: () => 60,
  snowLineAt: () => 9999,
}
const dry = { isSubmerged: () => false }
const clear = { nearest: () => null }

// The camera has to stand ON the flat world, not at y = 1.6 in absolute terms:
// the tier test is a 3D distance, so an eye 60 m under the ground puts every
// tuft in the world past the last band and the LOD section below would pass by
// measuring nothing.
const EYE = 60 + 1.6

const scene = new THREE.Scene()
const texArray = buildTextureArray()
const grass = new Grass(scene, flat, dry, clear, texArray, { seed: 7 })
grass.place(0, 0)
// One update settles the near tiles and one phase of the far ones; VEIL_PHASES
// of them settles every tile. The camera does not move between them, so this is
// still one frame's answer -- just the fully swept version of it, which is the
// only state the veil section below can assert on.
for (let f = 0; f < VEIL_PHASES; f++) grass.update(0, EYE, 0)
const st = grass.stats

check(st.rejected.elev + st.rejected.slope + st.rejected.water + st.rejected.snow + st.rejected.path === 0,
  'nothing rejected on a flat dry world', JSON.stringify(st.rejected))
check(st.used === st.placed, 'the pool ledger agrees with the tile ledger', `${st.used} vs ${st.placed}`)
check(st.used < st.pool, 'the pool is not exhausted', `${st.used}/${st.pool}`)
check(st.pool < st.used * 2, 'the pool is not wildly oversized', `${st.used}/${st.pool}`)

// The count the whole design rests on: pi*F^2*D inside, 2*pi*F*D*(R-F) beyond.
const ideal = Math.PI * FULL_RADIUS ** 2 * DENSITY + 2 * Math.PI * FULL_RADIUS * DENSITY * (DRAW_RADIUS - FULL_RADIUS)
check(st.placed > ideal * 0.9 && st.placed < ideal * 1.35,
  'the instance count matches the thinning integral',
  `${st.placed} placed, ${Math.round(ideal)} ideal`)
// What a HARD disc would have cost, which is the number the thinning buys back.
check(st.placed < Math.PI * DRAW_RADIUS ** 2 * DENSITY * 0.6,
  'thinning beats a hard disc by better than 40%',
  `${st.placed} vs ${Math.round(Math.PI * DRAW_RADIUS ** 2 * DENSITY)}`)

// THE LAW ITSELF, measured. Surface density in an annulus, against D*min(1, F/r).
const sigma = (r0, r1) => {
  let n = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const d = Math.hypot(grass.instX[id], grass.instZ[id])
      if (d >= r0 && d < r1) n++
    }
  }
  return n / (Math.PI * (r1 * r1 - r0 * r0))
}
const inner = sigma(4, FULL_RADIUS * 0.8)
check(near(inner, DENSITY, DENSITY * 0.12), `full density inside ${FULL_RADIUS} m`,
  `${inner.toFixed(2)}/m^2, want ${DENSITY}`)
for (const r of [30, 60]) {
  const measured = sigma(r * 0.85, r * 1.15)
  const want = (DENSITY * FULL_RADIUS) / r
  // The band is one-sided-ish on purpose: a tile is thinned from its NEAREST
  // corner, so quantisation always over-keeps and never under-keeps.
  check(measured > want * 0.95 && measured < want * 1.3, `density at ${r} m follows F/r`,
    `${measured.toFixed(2)}/m^2, want ${want.toFixed(2)}`)
}
{
  // ...and the halving, stated as the brief states it.
  const a = sigma(25, 35)
  const b = sigma(50, 70)
  check(near(a / b, 2, 0.35), 'twice the distance, half the density', `ratio ${(a / b).toFixed(2)}`)
}

// The triangle bill, which is what DESIGN.md §5 spends.
check(st.tris > 0 && st.tris < 70_000, 'the carpet is under 70k triangles',
  `${(st.tris / 1000).toFixed(1)}k over ${st.placed} tufts`)

// Tiles small enough that a tile's own width does not defeat the thinning, and
// small enough that one build job is not a hitch.
check(TILE / FULL_RADIUS < 0.5, 'a tile is under half the full-density radius',
  `${TILE}/${FULL_RADIUS} = ${(TILE / FULL_RADIUS).toFixed(2)}`)
check(TILE * TILE * DENSITY <= 256, 'a tile is at most 256 candidates', `${TILE * TILE * DENSITY}`)

// --- 4. the fade ------------------------------------------------------------

console.log('\n-- fade --')

// Counted here, re-used by the veil section: the two arrive at it from opposite
// directions and have to agree.
let standingPastGone = 0
// The same count, but past the threshold the VEIL actually uses -- which is a
// slack metre or so beyond the dissolve distance, so that a tuft the camera is
// closing on is shown again before it needs to be drawn. See VEIL_SLACK_MIN.
let standingPastSlack = 0

{
  const fade = grass.batch._colorsTexture.image.data
  let minGone = Infinity
  let maxGone = -Infinity
  let atRim = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const gone = fade[id * 4 + 3]
      // 3D, because that is what the shader compares against: the fade reads
      // distance(cameraPosition, fadeRoot), and at 1.6 m of eye height over a
      // 20 m full-density radius the vertical leg is not a rounding.
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      minGone = Math.min(minGone, gone)
      maxGone = Math.max(maxGone, gone)
      // Instances the TILE kept but the FADE has already dissolved. Not a bug --
      // see "the tile keep is a superset" in grass.js -- but the size of it is
      // the price of the tile grid, so it is measured rather than assumed.
      if (gone < d) standingPastGone++
      if (gone + grass.veilSlack < d) standingPastSlack++
      if (gone >= DRAW_RADIUS - 1e-3) atRim++
    }
  }
  // THE TILE'S KEEP IS A CONSERVATIVE SUPERSET OF THE FADE'S EXACT LAW, and
  // this is what that costs. A tile is thinned once, from its NEAREST corner,
  // so a tuft on its far edge is kept as though it stood up to a tile-diagonal
  // closer than it does -- and the dither then dissolves it anyway, because the
  // fade distance is per instance and exact. The result is right (the visible
  // density is the continuous law, with no step at a tile boundary) and the
  // price WOULD be instances that transform and discard, except that the veil
  // takes them off the GPU -- see the veil section below, which pins that these
  // and only these are the hidden ones. They stay RESIDENT because they are
  // exactly the tufts that appear as the player walks toward them, so showing
  // one again is a byte where regrowing the tile is a job. Trees run the same
  // arithmetic at the same tile-to-radius ratio. Bound it, do not forbid it --
  // and if this number climbs, the cause is TILE growing against FULL_RADIUS,
  // not the fade.
  check(standingPastGone < grass.placed * 0.25, 'the tile over-keep stays under a quarter of the pool',
    `${standingPastGone} of ${grass.placed} dissolved but resident`)
  check(maxGone <= DRAW_RADIUS + 1e-3, 'nothing is told to dissolve past the draw radius',
    `max ${maxGone.toFixed(1)} m`)
  // The clamp has to BITE, or the rim is a hard edge for the densest ranks.
  check(atRim > 0, 'the densest ranks are clamped to the draw radius', `${atRim} tufts`)
  check(minGone > FULL_RADIUS * 0.98, 'nothing dissolves before the full-density radius',
    `min ${minGone.toFixed(1)} m`)
  // 1 m is the "never fade" sentinel in the shader (see FADE_VERTEX): a tuft
  // left at three's default alpha of 1 would pop instead of fading.
  check(minGone > 1, 'every instance carries a real distance, not the default 1')
}

// --- 5. the veil -------------------------------------------------------------
//
// The veil hides the instances the dither has already dissolved to nothing. The
// whole safety argument is one claim -- that it hides EXACTLY the instances
// whose every fragment was already being discarded -- so it is checked in both
// directions. A false positive is a tuft that vanishes while still partly
// visible, which is the pop the dither exists to prevent; a false negative is
// simply the waste it was built to recover.
//
// `grass.update` has been called once per phase above, so every far tile has
// had its turn and the sweep is settled. That is the state to assert on: mid-
// sweep the answer is allowed to be stale, and VEIL_PHASES argues why.

console.log('\n-- veil --')

{
  let hiddenButVisible = 0
  let shownButGone = 0
  let hidden = 0
  let ledger = 0
  // The veil hides at `gone + slack`, not at `gone`. The slack is hysteresis --
  // it is what keeps a tuft the camera is closing on from having to be shown in
  // the same frame it is needed, given the sweep only reaches a tile every
  // VEIL_PHASES frames -- so the band between the two is deliberately left
  // resident and drawn. It is bounded below rather than forbidden.
  const slack = grass.veilSlack
  // The bill rebuilt from the LOD law rather than read off the class, so the
  // reported triangle count is checked against first principles and not against
  // itself.
  let billFull = 0
  let billDrawn = 0
  for (const tile of grass.tiles.values()) {
    ledger += tile.veiled
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      const vis = grass.batch.getVisibleAt(id)
      if (!vis) hidden++
      if (!vis && d < grass.instGone[id]) hiddenButVisible++
      if (vis && d > grass.instGone[id] + slack) shownButGone++
      const band = LOD_BANDS.findIndex((b) => d < b)
      const tris = bank.tiers[band < 0 ? bank.cardTier : band].triangles
      billFull += tris
      if (vis) billDrawn += tris
    }
  }
  // THE ONE THAT MATTERS. Nothing is hidden while any of it would still have
  // been drawn.
  check(hiddenButVisible === 0, 'nothing is veiled while it is still on screen',
    `${hiddenButVisible} cut early`)
  check(shownButGone === 0, 'nothing past the veil threshold is left on the GPU',
    `${shownButGone} still submitted`)
  // What the slack costs, at rest. These ARE fully dissolved and ARE drawn --
  // the honest price of not having to be right in the frame the tuft is needed.
  check(standingPastGone - standingPastSlack < grass.placed * 0.02,
    'the slack band is a rounding on the carpet',
    `${standingPastGone - standingPastSlack} tufts inside ${slack.toFixed(2)} m of slack`)
  check(hidden > grass.placed * 0.1, 'the veil is actually recovering something',
    `${hidden} of ${grass.placed} hidden, ${((hidden / grass.placed) * 100).toFixed(1)}%`)
  // The stat the panel reads has to agree with the batch, or the triangle count
  // it reports is fiction.
  check(ledger === hidden && grass.stats.veiled === hidden,
    'the veil ledger agrees with the batch',
    `${grass.stats.veiled} stat, ${ledger} tiles, ${hidden} batch`)
  // The veiled instances are the over-kept ones and nothing else: the fade
  // section counted them independently, one tile-thinning law against one
  // per-instance one.
  check(hidden === standingPastSlack, 'the veil hides exactly the tile over-keep',
    `${hidden} veiled, ${standingPastSlack} over-kept past the slack`)

  // EVERYTHING VEILED IS A CARD, and that is a proof rather than a measurement:
  // no tuft is given a dissolve distance under FULL_RADIUS (rank u < 1, so
  // fullRadius/u > fullRadius), and FULL_RADIUS is also the last LOD band, so
  // anything past its own dissolve distance is past the last band. The veil can
  // therefore never take a 6-triangle tuft out from under the player's feet --
  // which is the failure this pins, and it breaks the moment LOD_BANDS is
  // allowed to reach past FULL_RADIUS.
  check(LOD_BANDS[LOD_BANDS.length - 1] <= FULL_RADIUS,
    'the last LOD band does not reach past the full-density radius',
    `${LOD_BANDS[LOD_BANDS.length - 1]} m band, ${FULL_RADIUS} m full`)
  let veiledMesh = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (grass.batch.getVisibleAt(id)) continue
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      if (LOD_BANDS.some((b) => d < b)) veiledMesh++
    }
  }
  check(veiledMesh === 0, 'nothing veiled was a mesh tier', `${veiledMesh} mesh tufts hidden`)

  // Ids are NOT freed. Re-showing a tuft the player is walking toward has to be
  // a byte, not a regrown tile -- and a freed id would have to be re-placed
  // from the RNG stream, which is the expensive path this avoids.
  check(grass.maxInstances - grass.freeCount === grass.placed,
    'a veiled instance keeps its pool id', `${grass.maxInstances - grass.freeCount} held`)

  // And the triangle bill has to have actually come down, or none of the above
  // bought anything. `billFull` is what the carpet would cost with every
  // resident tuft submitted, which is what it cost before the veil existed.
  check(st.tris === billDrawn, 'the reported bill is the drawn bill',
    `${st.tris} reported, ${billDrawn} from the LOD law`)
  check(billDrawn < billFull * 0.88, 'the veil takes a real bite out of the bill',
    `${(billFull / 1000).toFixed(1)}k resident, ${(billDrawn / 1000).toFixed(1)}k drawn, ` +
    `${(((billFull - billDrawn) / billFull) * 100).toFixed(1)}% recovered`)
}

// THE VEIL UNDER MOTION, which is the only place it can go wrong. A stationary
// camera settles and every decision is exact; a moving one is acting on
// decisions up to VEIL_PHASES frames old, and the failure that buys is a tuft
// still hidden after it has come back inside its own fade -- a pop, and exactly
// the pop the dither exists to prevent.
//
// So this reconstructs the SHADER'S OWN opacity for every hidden tuft, every
// frame, and asserts it is zero. Nothing is allowed to be hidden while any part
// of it would have been drawn. The speed profiles are chosen for what they
// stress rather than for realism: a constant sprint stresses the sweep period,
// a standing start and a ramp stress the slack estimate (both were caught here
// -- an index-based phase let tiles miss their turn, and a slack sized to the
// old speed left 5% of a tuft showing when the player broke into a run), and
// the jitter stresses both at once.
{
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  // Must match FADE_BAND in material.js -- the fraction of `gone` the dissolve
  // is spread over.
  const FADE_BAND = 0.85
  const PROFILES = {
    'a stroll': () => 1.5 / 60,
    'a sprint': () => 12 / 60,
    'a standing start': (f) => (f < 30 ? 0 : 12 / 60),
    'a stop-start': (f) => (Math.floor(f / 20) % 2 ? 12 : 0) / 60,
    'a hard ramp': (f) => (30 * (f / 180)) / 60,
    'a jittering camera': (f) => (((f * 2654435761) >>> 0) % 20) / 60,
  }
  for (const [name, step] of Object.entries(PROFILES)) {
    const g = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7 })
    g.place(0, 0)
    let x = 0
    for (let f = 0; f < VEIL_PHASES; f++) g.update(x, EYE, 0)
    let worst = 0
    for (let f = 0; f < 180; f++) {
      x += step(f)
      g.update(x, EYE, 0)
      for (const tile of g.tiles.values()) {
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          if (g.batch.getVisibleAt(id)) continue
          const gone = g.instGone[id]
          const d = Math.hypot(g.instX[id] - x, g.instZ[id], g.instY[id] - EYE)
          worst = Math.max(worst, 1 - smoothstep(gone * FADE_BAND, gone, d))
        }
      }
    }
    check(worst === 0, `nothing pops in under ${name}`,
      `worst hidden tuft at ${(worst * 100).toFixed(2)}% opacity`)
    g.dispose()
  }
}

// --- 6. per-instance variation ----------------------------------------------

console.log('\n-- variation --')

{
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  let minH = Infinity
  let maxH = -Infinity
  let sumH = 0
  let n = 0
  let aspectBad = 0
  let isotropyBad = 0
  let yawSpread = 0
  const hues = []
  let greenest = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      grass.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      const h = s.y * GRASS_BASE.height
      minH = Math.min(minH, h)
      maxH = Math.max(maxH, h)
      sumH += h
      n++
      // Width follows height by its SQUARE ROOT: a 1.5 m tuft is long grass,
      // not a 1.5 m wide bush. See the note in _growTile.
      if (Math.abs(s.x - Math.sqrt(s.y)) > 1e-4) aspectBad++
      // x and z equal, or the billboard's yaw-about-Y stops commuting with the
      // instance scale and distant tufts shear as the player turns.
      if (Math.abs(s.x - s.z) > 1e-6) isotropyBad++
      if (Math.abs(q.y) > 0.7) yawSpread++

      grass.batch.getColorAt(id, c)
      hues.push(c.g > 0 ? c.r / c.g : 0)
      greenest = Math.max(greenest, c.g)
    }
  }
  check(near(minH, HEIGHT[0], 0.02), `the shortest tuft is ${HEIGHT[0]} m`, `${minH.toFixed(3)} m`)
  check(near(maxH, HEIGHT[1], 0.02), `the tallest tuft is ${HEIGHT[1]} m`, `${maxH.toFixed(3)} m`)
  check(near(sumH / n, (HEIGHT[0] + HEIGHT[1]) / 2, 0.05), 'heights are uniform over the range',
    `mean ${(sumH / n).toFixed(3)} m`)
  check(aspectBad === 0, 'width follows height by its square root', `${aspectBad} off`)
  check(isotropyBad === 0, 'horizontal scale is isotropic', `${isotropyBad} off`)
  check(yawSpread > n * 0.2, 'yaw is spread, not stuck', `${((yawSpread / n) * 100).toFixed(0)}% past a quarter turn`)

  // The tint moves along the lush -> dry line rather than being one colour, and
  // it stays GREEN-DOMINANT: these are linear values, so a carpet whose red
  // beats its green has had the sRGB conversion dropped.
  hues.sort((a, b) => a - b)
  const lo = hues[Math.floor(hues.length * 0.05)]
  const hi = hues[Math.floor(hues.length * 0.95)]
  const median = hues[Math.floor(hues.length * 0.5)]
  check(hi - lo > 0.15, 'the tint spans lush to dry', `r/g from ${lo.toFixed(2)} to ${hi.toFixed(2)}`)
  check(lo < 0.75, 'the lush end is properly green', `r/g min ${lo.toFixed(2)}`)
  // The dry end is STRAW, so red genuinely beats green there -- that is what
  // dead grass is, and the authored sRGB tint (0.60, 0.56, 0.30) says so. What
  // this pins is that it stops at straw and does not run on into rust.
  check(hi < 1.25, 'the dry end is straw, not rust', `r/g max ${hi.toFixed(2)}`)
  // And that the MASS of the bed is green: `tintT` is squared before it picks a
  // point on the line for exactly this reason. A median past 1 would be a
  // meadow of dead grass with green as the exception.
  check(median < 0.85, 'the median tuft is green, not straw', `r/g median ${median.toFixed(2)}`)
  // Linear, not sRGB. The authored tints are 0.30-0.60 in sRGB, which is
  // 0.07-0.32 linear; a missing conversion shows up as a carpet twice as bright.
  check(greenest < 0.4, 'the tint is linear, not sRGB', `brightest green ${greenest.toFixed(3)}`)
}

// --- 6. the LOD ladder ------------------------------------------------------

console.log('\n-- lod --')

{
  const counts = new Array(bank.tiers.length).fill(0)
  let wrongTier = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      // A VEILED instance keeps whatever tier it last held -- the near loop
      // skips the tier work once it has decided not to draw it, because the
      // geometry id of an invisible instance is not a thing anyone reads. Count
      // them here and the gate would be measuring a number nobody maintains.
      if (!grass.batch.getVisibleAt(id)) continue
      const t = grass.tierAt[id]
      counts[t]++
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      // Hysteresis only ever pushes a boundary OUT, and only for an instance
      // that already held the finer tier -- on the frame after `place` nothing
      // has moved, so the true bands hold exactly.
      const want = LOD_BANDS.findIndex((b) => d < b)
      if (t !== (want < 0 ? bank.cardTier : want)) wrongTier++
    }
  }
  check(wrongTier === 0, 'every tuft is on the tier its distance names', `${wrongTier} off`)
  // Over the DRAWN carpet, not the resident one -- everything the veil hid was
  // a card (see the veil section), so counting those would flatter this.
  const drawn = st.placed - st.veiled
  check(counts[bank.cardTier] / drawn > 0.75, 'the card tier carries most of the carpet',
    `${((counts[bank.cardTier] / drawn) * 100).toFixed(0)}% of ${drawn} drawn`)
  console.log(`       tiers: ${counts.map((c, i) => `${bank.tiers[i].name} ${c}`).join('   ')}`)
}

// --- 7. placement exclusions ------------------------------------------------
//
// Grass is the undercarpet, so it is deliberately more permissive than the fern
// bed -- but the four things it does refuse are the ones where grass reads as a
// bug rather than as scenery.

console.log('\n-- placement --')

{
  const wet = { isSubmerged: (x, z, y) => y < 61 }
  const roaded = { nearest: (x, z, kind) => (kind === 'road' ? { dist: 0.1, halfWidth: 2 } : null) }
  const snowy = { heightAndSlopeAt: () => ({ h: 60, tan: 0 }), snowLineAt: () => 60 }
  const cliff = { heightAndSlopeAt: () => ({ h: 60, tan: 9 }), snowLineAt: () => 9999 }
  const sunk = { heightAndSlopeAt: () => ({ h: 1, tan: 0 }), snowLineAt: () => 9999 }

  const one = (field, water, paths) => {
    const g = new Grass(new THREE.Scene(), field, water, paths, texArray, { seed: 7 })
    g.place(0, 0)
    const s = g.stats
    g.dispose()
    return s
  }
  check(one(flat, wet, clear).placed === 0, 'no grass in a lake')
  check(one(flat, dry, roaded).placed === 0, 'no grass down the middle of a road')
  check(one(snowy, dry, clear).placed === 0, 'no grass in a snowfield')
  check(one(cliff, dry, clear).placed === 0, 'no grass on a cliff')
  check(one(sunk, dry, clear).placed === 0, 'no grass below the minimum elevation')

  // Looser than the fern bed on every axis that matters, which is the whole
  // reason grass has its own PLACEMENT block rather than importing the fern's.
  check(PLACEMENT.maxSlopeDeg > 32, 'grass holds ground a tree will not', `${PLACEMENT.maxSlopeDeg} deg`)
  check(PLACEMENT.pathClearance < 1.0, 'grass grows to the verge', `${PLACEMENT.pathClearance} m`)
  check(PLACEMENT.minElev < 22, 'grass reaches lower than ferns do', `${PLACEMENT.minElev} m`)
}

// --- 8. the bake ------------------------------------------------------------
//
// No GL here, so the render itself cannot run -- what IS checked is that the
// bake is aimed at the card's layer and framed to the tuft rather than to the
// already-inflated card, which is the one arithmetic mistake in the pair.

console.log('\n-- bake --')

check(typeof bakeGrassImpostor === 'function', 'the bake is exported')
check(GRASS_TIERS[0].planes === 3, 'the bake subject is the 3-plane tier', `${GRASS_TIERS[0].planes} planes`)
check(bank.cardLayer === LAYER.IMPOSTOR_GRASS, 'the bake target is the card layer')

// --- 9. the strip experiment ------------------------------------------------
//
// `style: 'strips'` swaps the tuft ladder for one flat card, metres wide,
// drawing the same cutout several times across itself. What is gated here is
// the ARITHMETIC THAT DECIDES WHETHER IT IS WORTH ANYTHING, because it is easy
// to state a saving from a comparison that is not fair and every one of these
// numbers is a way of not doing that:
//
//   * against the BILLBOARD tier, not the 3-plane one. The card tier is ~83% of
//     the drawn instances (section 6 measures it), so it is the only baseline a
//     saving can honestly be quoted against.
//   * at MATCHED COVERAGE, not at matched instance counts. A thinner bed is a
//     saving anyone can have for free by turning DENSITY down.
//   * at 0.64 of the strip's width, not its full width. A billboard always
//     presents its whole face; a fixed card at a random yaw presents
//     E|sin t| = 2/pi of it, and forgetting that factor overstates the strip by
//     more than half.
//
// If the measured factor ever drops toward 1 -- which is what would happen if a
// strip were segmented, or if stripKeep were turned down as though it were a
// performance knob -- the experiment has stopped being one and this says so.

console.log('\n-- strips --')

const stripBank = buildGrassStripBank()
check(stripBank.tiers.length === 1, 'a strip has no ladder to climb', `${stripBank.tiers.length} tier`)
check(stripBank.tiers[0].triangles === 2, 'a strip is two triangles', `${stripBank.tiers[0].triangles}`)
check(!stripBank.tiers[0].billboard && stripBank.cardLayer === LAYER.GRASS_TUFT,
  'a strip does not spin and wears the tuft itself')
check(stripBank.tiles === stripTiles(),
  'the bank tiles as many times as its proportions say', `${stripBank.tiles} copies`)
// The tile has to be as wide as the strip is tall, or the square tuft picture is
// drawn stretched. Derived rather than typed, so this is really a gate on
// STRIP_BASE having been changed without stripTiles() following it.
check(near(STRIP_BASE.width / stripBank.tiles, STRIP_BASE.height * (GRASS_BASE.width / GRASS_BASE.height), 0.05),
  'one tile is as wide as the strip is tall, so the cutout is not stretched',
  `${(STRIP_BASE.width / stripBank.tiles).toFixed(2)} m per tile`)

const stripUv = stripBank.tiers[0].geometry.attributes.uvProj
let uMax = 0
for (let i = 0; i < stripUv.count; i++) uMax = Math.max(uMax, stripUv.getX(i))
check(uMax === stripBank.tiles, 'u runs 0..tiles, which is what makes the repeat draw copies',
  `u max ${uMax}`)
stripBank.tiers[0].geometry.dispose()

const strips = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'strips' })
strips.place(0, 0)
for (let i = 0; i < VEIL_PHASES; i++) strips.update(0, EYE, 0)
const ss = strips.stats

// Facing area per triangle, both systems, at their own mean instance height.
// The tuft's card is the impostor extent (inflated by the bake margin) scaled by
// height/GRASS_BASE.height in y and its square root in xz; the strip is a
// rectangle of STRIP_TILES square clumps, so its height is both its dimensions.
const tuftH = (HEIGHT[0] + HEIGHT[1]) / 2
const tuftSy = tuftH / GRASS_BASE.height
const tuftFace = ext.width * Math.sqrt(tuftSy) * ext.height * tuftSy
const stripH = (STRIP_HEIGHT[0] + STRIP_HEIGHT[1]) / 2
// A tile is SQUARE, so a strip of n tiles is n x stripH metres of rectangle.
const stripTileN = (STRIP_TILES[0] + STRIP_TILES[1]) / 2
// 2/pi is E|sin t| over a uniform yaw: the fraction of its own width a FIXED
// card shows, averaged over every direction the player can look at it from.
// stripCoverage() is the other half of the honesty: the mask, the per-tile
// shrink and the flare all decide how much of that rectangle carries grass, and
// none of them can be seen from an instance matrix. Leaving it out was worth
// 60% to the strip, in the strip's favour.
const stripCover1 = stripCoverage()
const stripFace = (2 / Math.PI) * stripTileN * stripH * stripH * stripCover1
const perTri = (face, tri) => face / tri
const gain = perTri(stripFace, 2) / perTri(tuftFace, 2)
check(gain > 2.5, 'a strip carries more grass per triangle than the billboard it replaces',
  `${gain.toFixed(2)}x (${stripFace.toFixed(2)} m2 vs ${tuftFace.toFixed(2)} m2, 2 tri each)`)
// The shader's own contribution, stated rather than buried in the product
// above: if this ever climbs back toward 1 it means the mask was turned off AND
// the shrink was flattened, and the bed is a curtain again.
check(stripCover1 > 0.35 && stripCover1 < 0.95,
  'the shader is counted in the strip\'s coverage, not assumed away',
  `${stripCover1.toFixed(3)} of the card drawn (keep ${getStripTiling().keep}, short ${getStripTiling().short}, flare ${getStripTiling().flare})`)

// ...and the density is set so the two beds put the SAME amount of grass in
// front of the eye, which is the only setting under which the factor above is a
// saving rather than a thinning.
const tuftCover = DENSITY * tuftFace
const stripCover = STRIP_DENSITY * stripFace
check(near(stripCover / tuftCover, 1, 0.12), 'the strip bed is tuned to the tuft bed\'s coverage',
  `${stripCover.toFixed(2)} m2/m2 vs ${tuftCover.toFixed(2)}`)

check(ss.style === 'strips' && ss.placed > 0, 'the strip scatter places grass', `${ss.placed} strips`)

// A TILE IS SQUARE AND THERE ARE A WHOLE NUMBER OF THEM. The fragment stage
// derives its tile count from the instance's own x/y scale ratio (see the strip
// block in material.js), so these two facts are not properties of the geometry
// -- they are properties of what _growTile puts in the matrix, and a fractional
// count draws a sliced clump at the far end while a non-square one draws every
// clump stretched. The stretched case shipped once and no per-vertex gate here
// could see it, which is why this measures the matrices.
{
  const m = new THREE.Matrix4()
  const p3 = new THREE.Vector3()
  const q3 = new THREE.Quaternion()
  const s3 = new THREE.Vector3()
  const seen = new Map()
  let worstFrac = 0
  let worstAspect = 0
  let n = 0
  for (const tile of strips.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      strips.batch.getMatrixAt(tile.ids[k], m)
      m.decompose(p3, q3, s3)
      // What the shader will compute: uvProj.x runs 0..stripTiles(), rescaled by
      // the instance's own aspect.
      const count = stripBank.tiles * (s3.x / s3.y)
      worstFrac = Math.max(worstFrac, Math.abs(count - Math.round(count)))
      // ...and one of those tiles, in metres, against the card's height.
      const tileW = (STRIP_BASE.width * s3.x) / count
      const tileH = STRIP_BASE.height * s3.y
      worstAspect = Math.max(worstAspect, Math.abs(tileW / tileH - 1))
      seen.set(Math.round(count), (seen.get(Math.round(count)) ?? 0) + 1)
      n++
    }
  }
  const counts = [...seen.keys()].sort((a, b) => a - b)
  check(n > 100 && worstFrac < 1e-4, 'every strip is a whole number of clumps long',
    `worst ${worstFrac.toExponential(1)} of a clump over ${n} strips`)
  check(worstAspect < 1e-4, 'and every clump is drawn square, not stretched along the strip',
    `worst aspect error ${worstAspect.toExponential(1)}`)
  check(counts[0] === STRIP_TILES[0] && counts[counts.length - 1] === STRIP_TILES[1]
    && counts.length === STRIP_TILES[1] - STRIP_TILES[0] + 1,
    'and the whole of STRIP_TILES is drawn from, which is where the variety now comes from',
    counts.map((c) => `${c}:${((seen.get(c) / n) * 100).toFixed(0)}%`).join(' '))
}
check(ss.tris === (ss.placed - ss.veiled) * 2, 'every drawn strip costs exactly two triangles',
  `${(ss.tris / 1000).toFixed(1)}k`)
// The whole claim, end to end and measured rather than derived: the same
// hillside, the same coverage, fewer triangles.
check(ss.tris < st.tris / 2, 'the strip carpet costs less than half the tuft carpet',
  `${(ss.tris / 1000).toFixed(1)}k vs ${(st.tris / 1000).toFixed(1)}k`)

// A strip spans metres of ground, so it is rolled onto the line between its two
// ends rather than seated on one sample. On a slope that is the difference
// between grass lying on the hill and grass standing through it -- at the 38 deg
// placement limit a 4 m strip's ends differ by 3.1 m.
const RISE = 0.4 // metres per metre, ~22 degrees
const ramp = {
  heightAt: (x) => 60 + x * RISE,
  heightAndSlopeAt: (x) => ({ h: 60 + x * RISE, tan: RISE }),
  snowLineAt: () => 9999,
}
const tilted = new Grass(new THREE.Scene(), ramp, dry, clear, texArray, { seed: 7, style: 'strips' })
tilted.place(0, 0)
{
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const axis = new THREE.Vector3()
  let worst = 0
  let n = 0
  for (const tile of tilted.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      tilted.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      // The strip's own long axis, in world space. Its ends are where the card
      // actually meets the ground, so that is where the ground has to be.
      axis.set(1, 0, 0).applyQuaternion(q).multiplyScalar((STRIP_BASE.width * s.x) / 2)
      for (const sign of [-1, 1]) {
        const ex = p.x + sign * axis.x
        const ez = p.z + sign * axis.z
        const ey = p.y + sign * axis.y
        worst = Math.max(worst, Math.abs(ey - ramp.heightAt(ex, ez)))
        n++
      }
    }
  }
  // The only slack is the sink, which is deliberate and constant.
  check(n > 100 && worst < STRIP_SINK * (STRIP_HEIGHT[1] / STRIP_BASE.height) + 0.02,
    'a strip lies on the slope rather than through it',
    `worst end ${worst.toFixed(3)} m off over ${n} ends at ${(Math.atan(RISE) * 180 / Math.PI).toFixed(0)} deg`)
}
tilted.dispose()
strips.dispose()

grass.dispose()

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all grass checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
