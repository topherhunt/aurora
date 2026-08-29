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
//   what makes a 70 m carpet 23k instances instead of 46k -- and the strip bed
//   cuts further again on top of it, to 11k. The law is spread across a
//   quantised level table, a per-tile nearest-corner distance and a
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
  buildGrassStripBank, stripTiles, STRIP_BASE, STRIP_TILE_ASPECT, grassCardAspect,
  GRASS_CLUMP, GRASS_HEIGHT_REF,
} from '../src/props/grass-bank.js'
import { Grass, GRASS_TUNING } from '../src/v2/render/grass.js'
import { RIM_AT, RIM_HYST, RIM_HYST_FRAC } from '../src/v2/render/rim.js'
import {
  LAYER, LAYER_COUNT, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, buildTextureArray,
  shapeImageLayer, GRASS_FRAY_TUNING,
} from '../src/textures.js'
import {
  stripCoverage, stripClumpScale, stripTwistCoverage, getStripTiling,
  setPropClock, getPropClock, PROP_FADE_SECONDS,
} from '../src/material.js'
import { impostorCardExtents } from '../src/props/impostor.js'
import { readPng } from '../tools/props/png.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

const { DENSITY, FULL_RADIUS, DRAW_RADIUS, LOD_BANDS, RIM_PHASES, TILE, HEIGHT, PLACEMENT,
  GROW_FROM, GROW_TO, GROW_SCALE, GROW_SINK,
  STRIP_MATCH, STRIP_DENSITY, STRIP_HEIGHT, STRIP_TILES, STRIP_SINK,
  STRIP_FULL_RADIUS, STRIP_THIN, STRIP_THIN_OCTAVES, stripThinAt } = GRASS_TUNING

// --- 1. the bank ------------------------------------------------------------

console.log('\n-- bank --')

const bank = buildGrassBank()

// TWO TIERS AND NO MIDDLE ONE, which is the ladder's whole shape: the crossed
// clump where the player is standing, the camera-facing billboard everywhere
// else. The 2-plane tier that used to sit between them cost 4 triangles to show
// 1.27 quads of facing area, against the billboard's 2 for a full one -- see the
// note over GRASS_TIERS. Gated as a decision, because "add a middle LOD back"
// is exactly the change that would quietly undo it.
check(bank.tiers.length === 2, 'two tiers', bank.tiers.map((t) => t.name).join(' '))
check(
  bank.tiers.map((t) => t.planes).join(',') === '3,1',
  'planes go 3, 1',
  bank.tiers.map((t) => t.planes).join(',')
)
check(
  bank.tiers.map((t) => t.triangles).join(',') === '6,2',
  'triangles go 6, 2',
  `${bank.tiers.reduce((n, t) => n + t.triangles, 0)} in the whole ladder`
)
// The card MUST be last: render/grass.js indexes LOD_BANDS against tier order
// and throws if it is not, but the throw is at construction on the route, and
// here it is one line.
check(bank.cardTier === bank.tiers.length - 1, 'the billboard is the coarsest tier')
// AND THE SHIPPED BED CLIMBS NONE OF IT. LOD_BANDS is empty because an
// InstancedMesh holds exactly one geometry -- see THE ARENA IS AN InstancedMesh
// in render/grass.js. The bank still builds the clump because the clump is the
// impostor's SUBJECT, so the two-tier assertions above are about the BAKE and
// this one is about the bed. A band reappearing here means someone put a ladder
// back on a mesh that cannot hold one, and section 12 would then fail too.
check(
  LOD_BANDS.length === 0,
  'and the shipped bed has no bands at all -- one geometry, the card, everywhere',
  `${LOD_BANDS.length} bands, ${bank.tiers.length} tiers in the bank`
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
//
// ONE RING, NOT TWO, and the gate below says so because a splayed tuft was tried
// and reverted -- see THE CARDS DO NOT SPLAY in grass-bank.js. Every vertex on
// the one circle is also what keeps the bake honest: bakeGrassImpostor frames its
// camera to GRASS_BASE, so anything outside that circle is cropped out of the far
// tier's photograph.
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
const grass = new Grass(scene, flat, dry, clear, texArray, { seed: 7, style: 'tufts' })
grass.place(0, 0)
// One update settles the near tiles and one phase of the far ones; RIM_PHASES
// of them settles every tile. The camera does not move between them, so this is
// still one frame's answer -- just the fully swept version of it, which is the
// only state the rim section below can assert on. Every instance is FRESH on
// its first sweep and FRESH resolves with NO transition, so a settled stationary
// world holds no fades in flight and the rim's state is binary. That is the
// property the whole section leans on, and it is asserted rather than assumed.
//
// THE CLOCK HAS TO RUN, and a stopped one is not the conservative choice. Every
// tuft is born wearing the card tier, so the near tiles all swap to the clump on
// their first sweep and each swap leaves a cross-dissolve ghost -- a second,
// visible instance held out of the pool until _sweepFades retires it. Held at
// one instant those ghosts never age out, and a thousand of them sit in the
// ledger forever, which would read as a leak in `used` and a padded `tris` in
// every count below. A full fade between sweeps is also the truthful frame: the
// player never sees a boot transient, they see the settled bed.
for (let f = 0; f <= RIM_PHASES; f++) {
  setPropClock(f * PROP_FADE_SECONDS)
  grass.update(0, EYE, 0)
}
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
// The whole flat zone bar its outer fifth. F is 5 m now, which is barely wider
// than a tile, so there is no room left to skip the innermost metres the way
// this used to -- and no need: keep is exactly 1 everywhere inside F, so the
// disc from the player's feet outward is the same measurement.
const inner = sigma(0, FULL_RADIUS * 0.8)
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
//
// THE BOUND IS 1.0 AND IT USED TO BE 0.5, because FULL_RADIUS halved and TILE
// did not. What the ratio prices is the over-keep: a tile is thinned once from
// its NEAREST corner, so its far edge is kept as though it stood a tile closer
// than it does. At 0.8 that over-keep is real, and it is paid for in RESIDENT
// instances rather than drawn ones -- the per-instance fade distance is exact,
// so the rim dissolves the surplus and the batch never submits it. The gates
// above are what actually protect the picture: the F/r law is measured on the
// ground at 30 and 60 m, and it holds. This one is only here to stop the ratio
// climbing to where a tile is thinned as a single point.
check(TILE / FULL_RADIUS <= 1, 'a tile is no wider than the full-density radius',
  `${TILE}/${FULL_RADIUS} = ${(TILE / FULL_RADIUS).toFixed(2)}`)
check(TILE * TILE * DENSITY <= 256, 'a tile is at most 256 candidates', `${TILE * TILE * DENSITY}`)

// --- 4. the fade ------------------------------------------------------------

console.log('\n-- fade --')

// Counted here, re-used by the rim section: the two arrive at it from opposite
// directions and have to agree.
let standingPastRim = 0
// The same count, but past the threshold the RIM actually uses -- which is a
// slack metre or so beyond the trigger distance, so that a tuft the camera is
// closing on is shown again before it needs to be drawn. See RIM_SLACK_MIN.
let standingPastSlack = 0

{
  // THE GONE-DISTANCE IS NOT IN THE SLOT ANY MORE. The slot the shader reads
  // carries a clock stamp now (see the DISSOLVE header in material.js), so the
  // distances come off the rim's own array and the slot is checked separately,
  // for being the never-fade sentinel everywhere at rest.
  //
  // ON AN INSTANCED BED THAT SLOT IS AN ATTRIBUTE, not the alpha lane of a
  // colour texture -- an InstancedMesh's instanceColor is itemSize 3 in r180 and
  // has no fourth channel to hide a timer in. One float per instance, indexed
  // directly rather than at stride 4. See aPropFade in render/grass.js.
  const fadeAttr = grass.batch.geometry.getAttribute('aPropFade')
  check(!!fadeAttr && fadeAttr.itemSize === 1 && fadeAttr.count >= grass.maxInstances,
    'the dissolve rides on a per-instance attribute, one float wide',
    `${fadeAttr ? `${fadeAttr.count} x ${fadeAttr.itemSize}` : 'missing'} for ${grass.maxInstances} instances`)
  const fade = fadeAttr.array
  let minGone = Infinity
  let maxGone = -Infinity
  let atRim = 0
  let stamped = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const gone = grass.rim.gone[id]
      if (fade[id] !== 1) stamped++
      // 3D, because that is what the shader compares against: the fade reads
      // distance(cameraPosition, fadeRoot), and at 1.6 m of eye height over a
      // 20 m full-density radius the vertical leg is not a rounding.
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      minGone = Math.min(minGone, gone)
      maxGone = Math.max(maxGone, gone)
      // Instances the TILE kept but the RIM has already dissolved. Not a bug --
      // see "the tile keep is a superset" in grass.js -- but the size of it is
      // the price of the tile grid, so it is measured rather than assumed.
      if (gone * RIM_AT < d) standingPastRim++
      if (gone * RIM_AT + grass.rim.slack < d) standingPastSlack++
      if (gone >= DRAW_RADIUS - 1e-3) atRim++
    }
  }
  // THE TILE'S KEEP IS A CONSERVATIVE SUPERSET OF THE FADE'S EXACT LAW, and
  // this is what that costs. A tile is thinned once, from its NEAREST corner,
  // so a tuft on its far edge is kept as though it stood up to a tile-diagonal
  // closer than it does -- and the dither then dissolves it anyway, because the
  // fade distance is per instance and exact. The result is right (the visible
  // density is the continuous law, with no step at a tile boundary) and the
  // price WOULD be instances that transform and discard, except that the rim
  // takes them off the GPU -- see the rim section below, which pins that these
  // and only these are the hidden ones. They stay RESIDENT because they are
  // exactly the tufts that appear as the player walks toward them, so showing
  // one again is a byte where regrowing the tile is a job. Trees run the same
  // arithmetic at the same tile-to-radius ratio. Bound it, do not forbid it --
  // and if this number climbs, the cause is TILE growing against FULL_RADIUS,
  // not the fade.
  // Just under 25% while the trigger sat at `gone`, and just under 30% now that
  // it sits at `gone * RIM_AT` -- the trigger moved inward, so more of the
  // over-kept population is past it. That is the move being priced, not the tile
  // grid drifting, and if this number climbs further the cause is TILE growing
  // against FULL_RADIUS.
  check(standingPastRim < grass.placed * 0.3, 'the tile over-keep stays under a third of the pool',
    `${standingPastRim} of ${grass.placed} past the rim trigger but resident`)
  check(maxGone <= DRAW_RADIUS + 1e-3, 'nothing is told to dissolve past the draw radius',
    `max ${maxGone.toFixed(1)} m`)
  // The clamp has to BITE, or the rim is a hard edge for the densest ranks.
  check(atRim > 0, 'the densest ranks are clamped to the draw radius', `${atRim} tufts`)
  check(minGone > FULL_RADIUS * 0.98, 'nothing dissolves before the full-density radius',
    `min ${minGone.toFixed(1)} m`)
  // 1 is the "never fade" sentinel in the shader (see FADE_VERTEX), and at rest
  // it is what EVERY instance carries: a stamp in that slot is a transition in
  // flight, and a settled stationary world has none. A tuft left stamped after
  // its transition retired is a clock reading waiting to be misread the next
  // time its id is handed out.
  check(stamped === 0, 'no fade stamp is left in the slot once the world settles',
    `${stamped} of ${grass.placed} still stamped`)
  check(grass.rim.flightN === 0, 'no rim transition is in flight in a settled world',
    `${grass.rim.flightN} fading`)
}

// --- 5. the rim --------------------------------------------------------------
//
// The rim decides which instances are on the GPU at all: past its trigger a tuft
// dissolves over a quarter second and is then hidden, and coming back the other
// way it is shown and dissolves in. The whole safety argument is one claim --
// that nothing is hidden while any of it would still have been drawn -- so it is
// checked in both directions. A false positive is a tuft that vanishes while
// still on screen, which is the pop the dither exists to prevent; a false
// negative is simply the waste the sweep was built to recover.
//
// `grass.update` has been called once per phase above, so every far tile has had
// its turn and the sweep is settled. That is the state to assert on: mid-sweep
// the answer is allowed to be stale, and RIM_PHASES argues why.

console.log('\n-- rim --')

{
  let hiddenButVisible = 0
  let shownButGone = 0
  let hidden = 0
  let ledger = 0
  // The rim fires at `gone * RIM_AT + slack`, not at `gone`. The slack is
  // hysteresis -- it is what keeps a tuft the camera is closing on from having
  // to be shown in the same frame it is needed, given the sweep only reaches a
  // tile every RIM_PHASES frames -- so the band between the two is deliberately
  // left resident and drawn. It is bounded below rather than forbidden.
  const slack = grass.rim.slack
  // The bill rebuilt from the LOD law rather than read off the class, so the
  // reported triangle count is checked against first principles and not against
  // itself.
  let billFull = 0
  let billDrawn = 0
  for (const tile of grass.tiles.values()) {
    ledger += tile.rimHidden
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      const vis = grass.batch.getVisibleAt(id)
      const trigger = grass.rim.gone[id] * RIM_AT
      if (!vis) hidden++
      if (!vis && d < trigger) hiddenButVisible++
      if (vis && d > trigger + slack) shownButGone++
      // Two, unconditionally: there is no ladder, so distance does not enter it.
      billFull += 2
      if (vis) billDrawn += 2
    }
  }
  // THE ONE THAT MATTERS. Nothing is hidden while any of it would still have
  // been drawn.
  check(hiddenButVisible === 0, 'nothing is hidden while it is still inside its trigger',
    `${hiddenButVisible} cut early`)
  check(shownButGone === 0, 'nothing past the rim threshold is left on the GPU',
    `${shownButGone} still submitted`)
  // What the slack costs, at rest. These ARE past the trigger and ARE drawn --
  // the honest price of not having to be right in the frame the tuft is needed.
  check(standingPastRim - standingPastSlack < grass.placed * 0.02,
    'the slack band is a rounding on the carpet',
    `${standingPastRim - standingPastSlack} tufts inside ${slack.toFixed(2)} m of slack`)
  check(hidden > grass.placed * 0.1, 'the rim is actually recovering something',
    `${hidden} of ${grass.placed} hidden, ${((hidden / grass.placed) * 100).toFixed(1)}%`)
  // The stat the panel reads has to agree with the batch, or the triangle count
  // it reports is fiction.
  check(ledger === hidden && grass.stats.rimHidden === hidden,
    'the rim ledger agrees with the batch',
    `${grass.stats.rimHidden} stat, ${ledger} tiles, ${hidden} batch`)
  // THE STEADY STATE IS BINARY, which is the whole point of the clock: an
  // instance is hidden or whole, never parked at partial coverage. `isHidden`
  // is the rim's own answer and `getVisibleAt` is the batch's; they disagreeing
  // would mean a transition that never retired.
  let disagree = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (grass.rim.isHidden(id) === grass.batch.getVisibleAt(id)) disagree++
    }
  }
  check(disagree === 0, 'the rim and the batch agree about every instance',
    `${disagree} disagreements`)
  // The hidden instances are the over-kept ones and nothing else: the fade
  // section counted them independently, one tile-thinning law against one
  // per-instance one.
  check(hidden === standingPastSlack, 'the rim hides exactly the tile over-keep',
    `${hidden} hidden, ${standingPastSlack} over-kept past the slack`)

  // NOTHING IS HIDDEN NEAR THE PLAYER, and that is a proof rather than a
  // measurement: no tuft is given a dissolve distance under FULL_RADIUS (rank
  // u < 1, so fullRadius/u > fullRadius), so the closest trigger any tuft in the
  // world can carry is FULL_RADIUS * RIM_AT. Nothing may be hidden inside that.
  //
  // IT USED TO ALSO GUARD THE LADDER -- a mesh tier hidden by the rim is a hole
  // in geometry the player is standing on -- and there is no ladder to guard now
  // (LOD_BANDS is empty). What is left is the floor itself, which is the part
  // that protects the picture: at F = 5 and RIM_AT the floor is 4.63 m, so the
  // nearest dissolve in the world is still outside arm's reach.
  let nearestHidden = Infinity
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (grass.batch.getVisibleAt(id)) continue
      const d = Math.hypot(grass.instX[id], grass.instZ[id], grass.instY[id] - EYE)
      nearestHidden = Math.min(nearestHidden, d)
    }
  }
  check(nearestHidden >= FULL_RADIUS * RIM_AT - 1e-6,
    'nothing is hidden inside the closest trigger any tuft can carry',
    `nearest hidden ${nearestHidden.toFixed(2)} m, floor ${(FULL_RADIUS * RIM_AT).toFixed(2)} m`)

  // Ids are NOT freed. Re-showing a tuft the player is walking toward has to be
  // a byte, not a regrown tile -- and a freed id would have to be re-placed
  // from the RNG stream, which is the expensive path this avoids.
  check(grass.maxInstances - grass.freeCount === grass.placed,
    'a hidden instance keeps its pool id', `${grass.maxInstances - grass.freeCount} held`)

  // And the triangle bill has to have actually come down, or none of the above
  // bought anything. `billFull` is what the carpet would cost with every
  // resident tuft submitted, which is what it cost before the sweep existed.
  check(st.tris === billDrawn, 'the reported bill is the drawn bill',
    `${st.tris} reported, ${billDrawn} from the LOD law`)
  check(billDrawn < billFull * 0.88, 'the rim takes a real bite out of the bill',
    `${(billFull / 1000).toFixed(1)}k resident, ${(billDrawn / 1000).toFixed(1)}k drawn, ` +
    `${(((billFull - billDrawn) / billFull) * 100).toFixed(1)}% recovered`)
}

// THE RIM UNDER MOTION, which is the only place it can go wrong. A stationary
// camera settles and every decision is exact; a moving one is acting on
// decisions up to RIM_PHASES frames old, and the failure that buys is a tuft
// still hidden after the camera has come back inside its trigger -- a hole in
// the carpet that fills in late.
//
// So this measures, every frame, how far INSIDE its own trigger the deepest
// hidden tuft is, against the hysteresis THAT tuft is allowed -- 2 m or 7.5% of
// its own gone-distance, whichever is wider. Zero is not the bound and never was
// under the clock: the re-show test carries that hysteresis, so a hidden tuft is
// allowed to be up to that far inside before the sweep brings it back. Anything
// beyond it is the sweep being late, which is the failure this exists to catch.
//
// The speed profiles are chosen for what they stress rather than for realism: a
// constant sprint stresses the sweep period, a standing start and a ramp stress
// the slack estimate (both were caught here -- an index-based phase let tiles
// miss their turn, and a slack sized to the old speed left 5% of a tuft showing
// when the player broke into a run), and the jitter stresses both at once.
{
  const PROFILES = {
    'a stroll': () => 1.5 / 60,
    'a sprint': () => 12 / 60,
    'a standing start': (f) => (f < 30 ? 0 : 12 / 60),
    'a stop-start': (f) => (Math.floor(f / 20) % 2 ? 12 : 0) / 60,
    'a hard ramp': (f) => (30 * (f / 180)) / 60,
    'a jittering camera': (f) => (((f * 2654435761) >>> 0) % 20) / 60,
  }
  for (const [name, step] of Object.entries(PROFILES)) {
    const g = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'tufts' })
    g.place(0, 0)
    let x = 0
    for (let f = 0; f < RIM_PHASES; f++) g.update(x, EYE, 0)
    let worst = 0
    let worstAllowed = 0
    let worstExcess = -Infinity
    for (let f = 0; f < 180; f++) {
      x += step(f)
      g.update(x, EYE, 0)
      for (const tile of g.tiles.values()) {
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          if (g.batch.getVisibleAt(id)) continue
          const gone = g.rim.gone[id]
          const allowed = Math.max(RIM_HYST, gone * RIM_HYST_FRAC)
          const d = Math.hypot(g.instX[id] - x, g.instZ[id], g.instY[id] - EYE)
          const inside = gone * RIM_AT - d
          if (inside - allowed > worstExcess) {
            worstExcess = inside - allowed
            worst = inside
            worstAllowed = allowed
          }
        }
      }
    }
    check(worst <= worstAllowed + 1e-6, `nothing is left hidden past the hysteresis under ${name}`,
      `deepest hidden tuft ${worst.toFixed(2)} m inside its trigger, ${worstAllowed.toFixed(2)} m allowed`)
    g.dispose()
  }
}

// THE CLOCK WRAPS, and a transition stamped either side of the wrap has to
// retire anyway. `setPropClock` folds at PROP_CLOCK_WRAP so the packing stays in
// range, which means a fade started at 1023.9 s reads an age of MINUS a thousand
// seconds on the next frame. `_retire` treats a negative age as out of the
// window in the other direction and finishes the transition; without that the
// prop freezes at whatever coverage its opening frame had and stays there for
// seventeen minutes, which is the permanent stipple in its purest form.
//
// Driven at the rim rather than walked into, because reaching the wrap by
// updating is seventeen minutes of frames.
{
  const g = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'tufts' })
  g.place(0, 0)
  for (let f = 0; f < RIM_PHASES; f++) g.update(0, EYE, 0)
  const id = [...g.tiles.values()].flatMap((t) => [...t.ids.slice(0, t.n)])
    .find((i) => !g.rim.isHidden(i))
  if (id === undefined) throw new Error('check-grass: no visible tuft to wrap the clock under')

  setPropClock(0.05)
  g.rim._startFade(id, getPropClock(), false)
  const slot = g.batch.geometry.getAttribute('aPropFade').array
  check(g.rim.isBusy(id) && slot[id] < 0,
    'a rim fade stamped just after a wrap is in flight', `slot ${slot[id].toFixed(3)}`)
  // The clock has gone BACKWARDS relative to the stamp, which is what a wrap
  // looks like from inside a transition that straddles it.
  setPropClock(1023.9)
  g.update(0, EYE, 0)
  check(!g.rim.isBusy(id) && g.rim.flightN === 0,
    'and the wrap retires it instead of freezing it at its opening frame',
    `state resolved, ${g.rim.flightN} still in flight`)
  check(slot[id] === 1,
    'and the slot goes back to the never-fade sentinel',
    `slot ${slot[id]}`)
  // It was a fade OUT, so the resolved state is hidden -- the wrap must not turn
  // a departure into an arrival.
  check(g.rim.isHidden(id) && !g.batch.getVisibleAt(id),
    'and it lands where the transition was headed, not back where it started')
  setPropClock(0)
  g.dispose()
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

// --- 6. the one tier --------------------------------------------------------
//
// There is no ladder any more -- see THE ARENA IS AN InstancedMesh in
// render/grass.js -- so what used to be a band-crossing gate is now a gate on
// the ladder STAYING gone. An InstancedMesh has exactly one geometry, and the
// two ways that breaks are both silent in Node: the bed keeping a second tier
// it can never draw (every instance on it would render as the wrong plant), and
// the surviving tier being the CLUMP rather than the card (three times the
// triangles, and the clump does not billboard because the billboard list names
// IMPOSTOR_GRASS alone).

console.log('\n-- one tier --')

{
  check(grass.tierCount === 1 && grass.cardTier === 0,
    'the bed has exactly one tier and it is the card',
    `${grass.tierCount} tier, cardTier ${grass.cardTier}`)
  check(grass.tierTris.length === 1 && grass.tierTris[0] === 2,
    'and that tier is two triangles, at every distance',
    `${grass.tierTris.join(',')} triangles a tier`)
  // Read off the geometry the arena actually holds rather than off the bank, so
  // a bank that kept the clump and an arena that took it cannot both pass.
  check(grass.batch.geometry.index.count / 3 === 2,
    'and the geometry in the arena is the card, not the clump it was baked from',
    `${grass.batch.geometry.index.count / 3} triangles against the clump's ${bank.tiers[0].triangles}`)
  let wrongTier = 0
  let n = 0
  for (const tile of grass.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (!grass.batch.getVisibleAt(id)) continue
      n++
      if (grass.tierAt[id] !== 0) wrongTier++
    }
  }
  check(n > 1000 && wrongTier === 0, 'and every drawn tuft is on it',
    `${wrongTier} off over ${n} drawn`)
  // The bill follows from that: two triangles times what the rim left standing,
  // with nothing on a 6-triangle tier to pad it.
  check(st.tris === (st.placed - st.rimHidden) * 2,
    'so the whole bill is two triangles a drawn tuft',
    `${st.tris} over ${st.placed - st.rimHidden} drawn`)
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
    const g = new Grass(new THREE.Scene(), field, water, paths, texArray, { seed: 7, style: 'tufts' })
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

// --- 9. the region bed ------------------------------------------------------
//
// `style: 'strips'` swaps the clump ladder for one flat card, metres wide,
// drawing the same cutout several times across itself. It is the DEFAULT and
// the canonical way to grass a region; the clump ladder is what a grassy POINT
// gets and is kept for that. What is gated here is
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
// performance knob -- then the reason a REGION is grassed with strips has gone
// away, and this says so before anyone rediscovers it in a frame time.

console.log('\n-- strips --')

const stripBank = buildGrassStripBank()
check(stripBank.tiers.length === 1, 'a strip has no ladder to climb', `${stripBank.tiers.length} tier`)
check(stripBank.tiers[0].triangles === 2, 'a strip is two triangles', `${stripBank.tiers[0].triangles}`)
check(!stripBank.tiers[0].billboard && stripBank.cardLayer === LAYER.GRASS_TUFT,
  'a strip does not spin and wears the tuft itself')
check(stripBank.tiles === stripTiles(),
  'the bank tiles as many times as its proportions say', `${stripBank.tiles} copies`)
// A TILE IS NOT SQUARE, and believing it was is what shipped the stretch. The
// cutout is a square photograph, but the tuft bed has never drawn it square: its
// card is a CHORD of the footprint circle and its width follows the SQUARE ROOT
// of its height, so the grass a player is used to looking at is 0.64 wide per
// unit tall at the bed's mean and 0.52 at its tallest. A square tile drew the
// same picture 1.5x wider than that. So the gate is against the tuft's own card,
// not against 1.
check(near(STRIP_BASE.width / stripBank.tiles, STRIP_BASE.height * STRIP_TILE_ASPECT, 1e-6)
  && near(STRIP_TILE_ASPECT, GRASS_CLUMP.width / GRASS_CLUMP.height, 1e-9),
  'a tile is drawn at the aspect the tuft bed draws the same cutout at',
  `${STRIP_TILE_ASPECT.toFixed(3)} wide per unit tall, vs the tuft card's ` +
  `${grassCardAspect(HEIGHT[0]).toFixed(2)}-${grassCardAspect(HEIGHT[1]).toFixed(2)} over its height range`)
// GRASS_CLUMP is computed in grass-bank.js from a COPY of the tuft bed's height
// range, because the import only runs one way. This is the gate that stops the
// copy going stale: raise HEIGHT here and the whole strip system resizes itself,
// or this fails and tells you where the other number lives.
check(near(GRASS_HEIGHT_REF[0], HEIGHT[0], 1e-9) && near(GRASS_HEIGHT_REF[1], HEIGHT[1], 1e-9),
  'and the tuft range the strips size themselves from is the tuft range',
  `[${GRASS_HEIGHT_REF}] vs [${HEIGHT}]`)

const stripUv = stripBank.tiers[0].geometry.attributes.uvProj
let uMax = 0
for (let i = 0; i < stripUv.count; i++) uMax = Math.max(uMax, stripUv.getX(i))
check(uMax === stripBank.tiles, 'u runs 0..tiles, which is what makes the repeat draw copies',
  `u max ${uMax}`)
// THE FLARE'S STRETCH COMPENSATION RIDES ON THIS IDENTITY. STRIP_VERTEX moves
// the tile coordinate by the same amount it moves the vertex, so that widening
// the top of a card reveals more grass instead of pulling the grass that is
// there sideways -- and it writes that displacement as `(stF - 1) * position.x`,
// which is only the right number of TILES if one unit of u is one unit of
// geometry width. STRIP_BASE.height = 1/aspect is what makes it so. Type a
// height there instead and nothing here changes shape; the top of every flared
// card just shears, silently.
check(near(uMax, STRIP_BASE.width, 1e-9),
  'and one unit of u is one unit of geometry width, which is what the flare rides on',
  `u span ${uMax} vs width ${STRIP_BASE.width}`)
stripBank.tiers[0].geometry.dispose()

// THE TWO STRATEGIES, GATED AS A DECISION RATHER THAN LEFT AS A COMMENT. Which
// bed you get when you do not ask for one is the whole of "clumps are canonical",
// and it is one word in a default parameter. Strips win on triangles and lose on
// FILL -- the per-ring sweep below measures them at 1.0x to 2.0x the tuft bed's
// facing area, and fill is the budget a headset runs out of first. The strip bed
// is checked to be still THERE in the same breath, because the thing that would
// quietly undo the other half of the decision is somebody reading a bed with no
// default caller as dead code and deleting it.
{
  const dflt = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7 })
  check(dflt.style === 'tufts', 'a region asked for grass without saying which gets clumps',
    `default style ${dflt.style}`)
  dflt.dispose()
  const clump = buildGrassBank()
  const planes = clump.tiers[0].geometry.userData.tuft.planes
  check(planes === 3 && clump.tiers.length === GRASS_TIERS.length,
    'and the 3-card clump a grassy POINT wants is still built and still crossed',
    `${planes} cards on ${clump.tiers.length} tiers`)
  for (const t of clump.tiers) t.geometry.dispose()
}

const strips = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'strips' })
strips.place(0, 0)
for (let i = 0; i < RIM_PHASES; i++) strips.update(0, EYE, 0)
const ss = strips.stats

// Facing area per triangle, both systems, at their own mean instance height.
// The tuft's card is the impostor extent (inflated by the bake margin) scaled by
// height/GRASS_BASE.height in y and its square root in xz; the strip is a
// rectangle of STRIP_TILES square clumps, so its height is both its dimensions.
const tuftH = (HEIGHT[0] + HEIGHT[1]) / 2
const tuftSy = tuftH / GRASS_BASE.height
const tuftFace = ext.width * Math.sqrt(tuftSy) * ext.height * tuftSy
const stripH = (STRIP_HEIGHT[0] + STRIP_HEIGHT[1]) / 2
// A tile is STRIP_TILE_ASPECT as wide as it is tall, so a strip of n tiles is
// n x aspect x stripH long and stripH tall.
const stripTileN = (STRIP_TILES[0] + STRIP_TILES[1]) / 2
// 2/pi is E|sin t| over a uniform yaw: the fraction of its own width a FIXED
// card shows, averaged over every direction the player can look at it from.
// stripCoverage() is the other half of the honesty: the mask, the per-tile
// shrink and the flare all decide how much of that rectangle carries grass, and
// none of them can be seen from an instance matrix. Leaving it out was worth
// 60% to the strip, in the strip's favour.
const stripCover1 = stripCoverage()
const stripFace = (2 / Math.PI) * stripTileN * STRIP_TILE_ASPECT * stripH * stripH * stripCover1

// IS A CLUMP OF STRIP GRASS THE SAME PLANT AS A CLUMP OF TUFT GRASS? Everything
// above is about area and density, and a bed can pass all of it while drawing
// grass that is visibly the wrong SIZE -- which is what happened: the strip bed
// read as short, and it was short, by exactly the 0.75 the per-tile shrink takes
// off every tile. A tile is not a clump. The clump is the tile after the shader
// has scaled it, so the mean clump is the mean tile times stripClumpScale(), and
// THAT is the number that has to equal the card the tuft bed draws.
const stripClump = {
  width: stripH * stripClumpScale() * STRIP_TILE_ASPECT,
  height: stripH * stripClumpScale(),
}
check(near(stripClump.width / GRASS_CLUMP.width, 1, 0.02)
  && near(stripClump.height / GRASS_CLUMP.height, 1, 0.02),
  'a clump of strip grass is the same plant as a clump of tuft grass',
  `${stripClump.width.toFixed(2)} x ${stripClump.height.toFixed(2)} m vs ` +
  `${GRASS_CLUMP.width.toFixed(2)} x ${GRASS_CLUMP.height.toFixed(2)}`)
// ...and no bigger at its biggest, or the bed grows a few outliers that read as
// a different species however well the mean matches.
check(STRIP_HEIGHT[1] * 1 <= HEIGHT[1] + 1e-9,
  'and the tallest strip clump is no taller than the tallest tuft',
  `${(STRIP_HEIGHT[1]).toFixed(2)} m vs ${HEIGHT[1].toFixed(2)}, shortest ` +
  `${(STRIP_HEIGHT[0] * getStripTiling().short).toFixed(2)} vs ${HEIGHT[0].toFixed(2)}`)
const perTri = (face, tri) => face / tri
const gain = perTri(stripFace, 2) / perTri(tuftFace, 2)
// A FLOOR AND NOT A TARGET, and it is set low deliberately. A strip is two
// triangles at ANY size, so this goes as the SQUARE of STRIP_HEIGHT and moves
// further than anything else in the file whenever the grass is resized -- it has
// been 2.5 when strips were oversized, 1.4 when they were cut back too far, and
// sits near 1.8 now that a clump is the same plant the tuft bed draws. The floor
// is where a strip stops being clearly worth more than the card it replaces;
// below it, the honest answer is to go back to tufts rather than to lower this.
check(gain > 1.4, 'a strip carries more grass per triangle than the billboard it replaces',
  `${gain.toFixed(2)}x (${stripFace.toFixed(2)} m2 vs ${tuftFace.toFixed(2)} m2, 2 tri each)`)
// The shader's own contribution, stated rather than buried in the product
// above: if this ever climbs back toward 1 it means the mask was turned off AND
// the shrink was flattened, and the bed is a curtain again.
check(stripCover1 > 0.35 && stripCover1 < 0.95,
  'the shader is counted in the strip\'s coverage, not assumed away',
  `${stripCover1.toFixed(3)} of the card drawn (keep ${getStripTiling().keep}, short ${getStripTiling().short}, flare ${getStripTiling().flare})`)
// The twist is the one part of the shader that changes a strip's SHAPE rather
// than what it draws on it, and the only thing to gate about it is that it stays
// an angle. At 0 the strip is a flat sheet again and every clump on it goes
// edge-on at the same instant; past 45 the leaning end is closer to lying down
// than standing up, and the picture on it is stretched by 1/cos, which is where
// the twist stops being free.
const twist = getStripTiling().twist
check(twist[0] > 0 && twist[0] < twist[1] && twist[1] <= 45,
  'a strip is warped out of its own plane rather than being a flat sheet',
  `${twist[0]}-${twist[1]} deg of lean at one top corner, costing ` +
  `${((1 - stripTwistCoverage()) * 100).toFixed(1)}% of facing area`)

// THE DENSITY HITS THE INVARIANT IT CLAIMS TO, which is the gate that replaced a
// hard-coded band, and the replacement is the point. STRIP_DENSITY was an
// eyeballed 1.64 for a while and every comparison downstream of it needed a
// paragraph of arithmetic before it meant anything. It is derived from
// STRIP_MATCH now -- see the header in render/grass.js -- so what there is to
// gate is that the derivation is right and that the other three quantities are
// REPORTED rather than quietly floating. An instance is not the same object in
// the two beds, so exactly one of these can be 1.00x and the gate's job is to
// make it obvious which.
const stripClumps = STRIP_DENSITY * stripTileN
const want = {
  instances: [STRIP_DENSITY / DENSITY, 'instances'],
  clumps: [stripClumps / DENSITY, 'clumps'],
  cards: [stripClumps / (DENSITY * GRASS_TIERS[0].planes), 'near-field cards'],
}[STRIP_MATCH]
check(want !== undefined && Math.abs(want[0] - 1) < 1e-9,
  `the bed holds ${STRIP_MATCH} equal to the tuft carpet, which is what it says it does`,
  `${want?.[1]} ${(want?.[0] ?? NaN).toFixed(4)}x`)
check(true, 'and the other counts are reported rather than left floating',
  `instances ${(STRIP_DENSITY / DENSITY).toFixed(2)}x  ` +
  `clumps ${(stripClumps / DENSITY).toFixed(2)}x  ` +
  `cards ${(stripClumps / (DENSITY * GRASS_TIERS[0].planes)).toFixed(2)}x  ` +
  `(${STRIP_DENSITY.toFixed(2)} strips/m2, ${stripTileN.toFixed(1)} clumps each)`)

// ...and the bed has to be in the same WORLD as the tuft carpet's coverage, or
// the saving above is a thinning. A WIDE bound and a printed ratio, because
// which way this lands is a consequence of STRIP_MATCH rather than a target:
// matching instances overshoots coverage, matching clumps starves it. What it
// still catches is an order of magnitude.
const tuftCover = DENSITY * tuftFace
const stripCover = STRIP_DENSITY * stripFace
check(stripCover / tuftCover > 0.3 && stripCover / tuftCover < 3,
  'the strip bed is in the same world as the tuft bed\'s coverage',
  `${stripCover.toFixed(2)} m2/m2 vs ${tuftCover.toFixed(2)} (${(stripCover / tuftCover).toFixed(2)}x)`)

// WHERE THE PLAYER IS STANDING, which is the ring neither gate above can see.
//
// Both of them compare a strip against ONE tuft card at its authored size, and
// neither of those is what the bed actually draws across a ring: the thinning
// falls as 1/d and the card GROWS to meet it, so coverage is a product of two
// functions of distance. A bed can be at matched coverage on the whole-bed
// arithmetic and still be half the grass in the ring the player occupies, which
// is exactly what "it looks sparser" turned out to be.
//
// Measured per ring off the real scatter, so the graded thinning, the rim and
// the far-field grow are all in it. Facing area is summed from the tier geometry
// itself: every quad is a vertical card of horizontal width w, and a FIXED card
// seen from a uniform yaw shows 2/pi of its width, which is the same factor the
// far-field comparison uses.
{
  const facingOf = (geo) => {
    const p = geo.getAttribute('position').array
    let sum = 0
    // Quads, in the order buildGrassTuft/buildGrassStrip push them: foot, foot,
    // top, top. So 0->1 is the base edge and 1->2 is the rise.
    for (let q = 0; q < p.length / 3; q += 4) {
      const i = q * 3
      sum += (2 / Math.PI)
        * Math.hypot(p[i + 3] - p[i], p[i + 5] - p[i + 2])
        * Math.abs(p[i + 7] - p[i + 1])
    }
    return sum
  }
  const tierFace = bank.tiers.map((t) => facingOf(t.geometry) * Math.sqrt(tuftSy) * tuftSy)
  // THE GROW, PRICED THE WAY THE VERTEX SHADER APPLIES IT (billboardGrowVertex
  // in material.js): g is linear on the part of the card still ABOVE ground, in
  // both dimensions, so the visible facing area is g squared. The sink does not
  // enter -- it is taken as a fraction of the grown card and the height scale is
  // solved to leave g times the card standing, which is the fix for the squat
  // rectangles the first version drew.
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const growFace = (d) => {
    const t = smooth(GROW_FROM, GROW_TO, d)
    const g = 1 + (GROW_SCALE - 1) * t
    return g * g
  }
  // The rings are the knees of the two laws that shape the bed: FULL_RADIUS is
  // where the thinning starts biting, and GROW_FROM..GROW_TO is the ramp that
  // pays it back. The last ring is the fully-grown far field, which is where
  // most of the instances and all of the fill actually are.
  const RINGS = [0, FULL_RADIUS, GROW_FROM, GROW_TO, DRAW_RADIUS]
  const ringOf = (d) => {
    for (let i = 0; i < RINGS.length - 1; i++) if (d >= RINGS[i] && d < RINGS[i + 1]) return i
    return -1
  }
  const sweep = (g, per) => {
    const f = new Array(RINGS.length - 1).fill(0)
    for (let id = 0; id < g.maxInstances; id++) {
      if (!g.batch.getVisibleAt(id)) continue
      const d = Math.hypot(g.instX[id], g.instZ[id])
      const r = ringOf(d)
      if (r >= 0) f[r] += per(d)
    }
    return f.map((v, i) => v / (Math.PI * (RINGS[i + 1] ** 2 - RINGS[i] ** 2)))
  }
  const tuftRings = sweep(grass, (d) => tierFace[bank.cardTier] * growFace(d))
  const stripRings = sweep(strips, () => stripFace)
  const ratios = stripRings.map((v, i) => v / tuftRings[i])
  const report = ratios.map((r, i) => `${RINGS[i]}-${RINGS[i + 1]}m ${r.toFixed(2)}x`).join('  ')
  // The floor is where it stands, not where it should be: the near ring is the
  // known weak spot of a bed with no ladder, and the honest fix is a near tier
  // (a crossed pair is 4 triangles and never goes edge-on) rather than more
  // instances. What this gate is for is stopping it slide further while nobody
  // is measuring that ring.
  check(ratios[0] > 0.5 && Number.isFinite(ratios[0]),
    'and the ring the player stands in is not half the grass it was', report)
  // AND THE FAR FIELD IS THE TUFT BED'S NOW, which is the whole point of halving
  // the distant density and growing the survivors. The strip bed used to win
  // this ring by 1.5x on the argument that one big sheet covers ground more
  // cheaply than many small cards; a card that grows to GROW_SCALE past GROW_TO
  // is the same argument applied to the card, and it wins because it does not
  // also pay the strip's per-pixel textureGrad.
  //
  // Stated against the un-grown bed at TWICE the density, because that is the
  // trade the user asked for -- half the instances, bigger cards, "preserve the
  // perceived lushness with less tris". A mean grow factor over the outer ring
  // above 2 means the coverage went UP while the instance count halved.
  const outer = RINGS.length - 2
  let growSum = 0
  let growN = 0
  for (let id = 0; id < grass.maxInstances; id++) {
    if (!grass.batch.getVisibleAt(id)) continue
    const d = Math.hypot(grass.instX[id], grass.instZ[id])
    if (d < RINGS[outer] || d >= RINGS[outer + 1]) continue
    growSum += growFace(d)
    growN++
  }
  const meanGrow = growSum / growN
  check(growN > 1000 && meanGrow > 2,
    'and the grow more than pays back the halving in the ring it was aimed at',
    `${meanGrow.toFixed(2)}x facing area over ${growN} tufts in ${RINGS[outer]}-${RINGS[outer + 1]} m, ` +
    `against the 2x the density lost`)
  check(tuftRings[outer] > stripRings[outer],
    'so the far field, where the fill actually is, is the tuft bed\'s',
    `${tuftRings[outer].toFixed(2)} m2/m2 vs the strips' ${stripRings[outer].toFixed(2)}`)
}

// THE STRIP BED'S EXTRA THINNING, DELIVERED AGAINST ASKED.
//
// STRIP_THIN is written as "from 8 m, half the grass", but each step ramps over
// STRIP_THIN_OCTAVES, so a ring whose inner part is still climbing its ramp gets
// LESS than the nominal cut. That gap is a property of the table, not a bug, and
// the only failure mode worth gating is losing track of which number is which:
// the ask ending up in a comment while the bed quietly delivers something else.
// So this measures three separate things -- the law's own arithmetic, the bed on
// the ground against that law, and the rim against it -- because a mismatch in
// any one of them is silent.
{
  // THE RINGS ARE STRIP_THIN'S OWN KNEES, plus the end of the last ramp, because
  // this gate asks whether the table is delivered and so each ring has to be
  // exactly one table entry's domain. A window that opens at a knee and shuts
  // before that knee's ramp has finished can only ever read low -- it would gate
  // the measurement rather than the bed. (They were once spelled with
  // FULL_RADIUS, which happened to be the second knee. FULL_RADIUS is 10 m now
  // and the coincidence is gone.)
  const RINGS = [
    0, ...STRIP_THIN.map(([r]) => r),
    STRIP_THIN[STRIP_THIN.length - 1][0] * 2 ** STRIP_THIN_OCTAVES, DRAW_RADIUS,
  ]
  const base = (d) => Math.min(1, FULL_RADIUS / d)
  // Area-weighted mean of f over an annulus, by the midpoint rule. 2000 steps
  // over 8 m is finer than anything in the law by three orders of magnitude.
  const ringMean = (f, r0, r1) => {
    let num = 0
    let den = 0
    for (let k = 0; k < 2000; k++) {
      const d = r0 + ((k + 0.5) / 2000) * (r1 - r0)
      num += f(d) * d
      den += d
    }
    return num / den
  }
  // What the table asks for across a ring: the last entry that has come into
  // force by the time the ring starts.
  const nominal = RINGS.slice(0, -1).map((r0) => {
    let want = 1
    for (const [r, f] of STRIP_THIN) if (r <= r0) want = f
    return want
  })
  const delivered = RINGS.slice(0, -1).map((r0, i) =>
    ringMean(base, r0, RINGS[i + 1]) / ringMean((d) => base(d) / stripThinAt(d), r0, RINGS[i + 1]))
  const askReport = delivered
    .map((v, i) => `${RINGS[i]}-${RINGS[i + 1]}m ${v.toFixed(2)} of ${nominal[i]}`).join('  ')
  // Never MORE than asked -- that direction would be the table being ignored
  // rather than ramped -- and never less than 70%, which is where a one-octave
  // ramp lands on the tightest ring (20-40 m, half of which is inside the ramp).
  check(delivered.every((v, i) => v <= nominal[i] * 1.001 && v >= nominal[i] * 0.7),
    'the strip bed thins by the amounts STRIP_THIN asks for, ramps included', askReport)

  // The law is one thing; what actually got scattered is another. Density here
  // is VISIBLE instances per square metre, so it exercises the whole chain --
  // the quantised level table, the per-tile nearest-corner distance, the rank
  // test and the rim -- against the continuous law they are all approximating.
  //
  // THE RIM PUTS ITS OWN FACTOR IN, and it is not a fudge either. A strip is
  // drawn while `_goneFor(u) * RIM_AT > d`, which is the same as `_goneFor(u) >
  // d / RIM_AT`, which is the law's own keep-fraction read a little further out
  // than the ring actually is. So the bed to expect is the law at `d / RIM_AT`,
  // and past `radius * RIM_AT` it is nothing at all -- `_goneFor` clamps to the
  // draw radius, so the outermost shell holds the ranks that would have run
  // further and now stop there. The old smoothstep drew that shell at falling
  // coverage instead of not at all; the cut sits at the midpoint of the band it
  // spanned, so the COVERAGE either delivers is the same and only the instance
  // count moved. See rim.js on why the trigger is the midpoint.
  const drawnKeep = (d) => (d / RIM_AT >= strips.radius ? 0 : strips._keepAt(d / RIM_AT))
  const perRing = (g) => {
    const n = new Array(RINGS.length - 1).fill(0)
    for (let id = 0; id < g.maxInstances; id++) {
      if (!g.batch.getVisibleAt(id)) continue
      const d = Math.hypot(g.instX[id], g.instZ[id])
      for (let i = 0; i < n.length; i++) if (d >= RINGS[i] && d < RINGS[i + 1]) n[i]++
    }
    return n.map((v, i) => v / (Math.PI * (RINGS[i + 1] ** 2 - RINGS[i] ** 2)))
  }
  const got = perRing(strips)
  const want = RINGS.slice(0, -1).map((r0, i) =>
    STRIP_DENSITY * ringMean(drawnKeep, r0, RINGS[i + 1]))
  const bedReport = got
    .map((v, i) => `${RINGS[i]}-${RINGS[i + 1]}m ${v.toFixed(2)} vs ${want[i].toFixed(2)}`).join('  ')
  check(got.every((v, i) => Math.abs(v / want[i] - 1) < 0.1),
    'and the bed on the ground is the bed the law describes, read at the rim trigger',
    `${bedReport} /m2`)

  // THE RIM AND THE THINNING CANNOT BE ALLOWED TO DISAGREE. _goneFor inverts
  // the keep law to decide where ONE instance dissolves; the level table decides
  // where its whole TILE thins. Drift between them does not throw -- it leaves
  // grass standing invisible, or dissolves grass the tiles still count.
  //
  // The invariant that matters is exact and is checked first: the distance
  // _goneFor returns falls inside the bracket whose two keep-fractions straddle
  // u, so the rim can never put an instance on the wrong side of a level.
  //
  // Against the CONTINUOUS law it is a geometric interpolation between two grid
  // samples, exact wherever the law is a straight power -- everywhere except the
  // two levels that straddle a STRIP_THIN radius, where the segment spans two
  // different exponents. That is gated at one quantiser step, because 19% is the
  // resolution the whole thinning works at: the tiles step in 19% jumps and the
  // dither fade spans 15% of the distance either way.
  const STEP = 2 ** (1 / GRASS_TUNING.QUANT) - 1
  let worstTrip = 0
  let bracketed = true
  for (const g of [grass, strips]) {
    for (let k = 1; k < 200; k++) {
      const u = k / 200
      const d = g._goneFor(u)
      if (d >= g.radius) continue
      worstTrip = Math.max(worstTrip, Math.abs(g._keepAt(d) / u - 1))
      let q = 1
      while (q <= g.maxQ && g.uAt[q] > u) q++
      if (d * d < g.loSq[q - 1] * (1 - 1e-9) || d * d > g.loSq[q] * (1 + 1e-9)) bracketed = false
    }
  }
  check(bracketed, 'and a strip dissolves on the same side of a level as its tile thins on')
  check(worstTrip < STEP, 'and it dissolves where the thinning law says, to finer than a level',
    `worst ${(worstTrip * 100).toFixed(1)}% vs the quantiser's own ${(STEP * 100).toFixed(0)}%`)

  // The tuft carpet's law is untouched by any of the above, and the closed form
  // it used to carry is the cheapest possible statement of that.
  let worstTuft = 0
  for (let k = 1; k < 200; k++) {
    const u = k / 200
    const want = Math.min(FULL_RADIUS / u, grass.radius)
    worstTuft = Math.max(worstTuft, Math.abs(grass._goneFor(u) / want - 1))
  }
  check(worstTuft < 1e-6, 'while the tuft carpet still dissolves at exactly fullRadius / u',
    `worst ${(worstTuft * 100).toExponential(1)}%, thinning from ${grass.thinFrom} m vs the strips' ${strips.thinFrom}`)

  // The two grids start together now -- see STRIP_FULL_RADIUS. What has to hold
  // is that NEITHER bed's grid starts after its own law bends, because level 0
  // is sampled at thinFrom and applied to everything inside it: a grid that
  // starts late thins the ground the player is standing on, uniformly, and it
  // reads as a thin patch around the camera rather than as a bug.
  check(strips.thinFrom <= FULL_RADIUS && grass.thinFrom <= FULL_RADIUS,
    'and neither bed quantises from further out than its law stays flat',
    `strips ${strips.thinFrom} m, tufts ${grass.thinFrom} m, law flat to ${FULL_RADIUS} m`)
}

check(ss.style === 'strips' && ss.placed > 0, 'the strip scatter places grass', `${ss.placed} strips`)

// THE SCATTER IS BLUE NOISE, MEASURED AGAINST THE THING IT REPLACED.
//
// The claim behind R2 in grass.js is that it puts the same number of strips down
// without the clumps and bare patches a uniform draw leaves, and "it looks more
// even" is not a claim a check file can hold. Mean nearest-neighbour distance is:
// for a Poisson (uniform) process at density L it is exactly 0.5/sqrt(L), and any
// scatter that refuses to double up beats that. So this measures the real bed and
// a same-count uniform control drawn over the same box, and gates on the ratio --
// which is scale-free, so it does not move when the density does.
//
// THE WINDOW REACHES PAST FULL_RADIUS, which it did not have to when that radius
// was 10 m. A 5 m flat zone holds about 300 strips, and at 300 points in a box
// the Poisson estimate is boundary-dominated -- the control reads 10% high and
// the gate would be measuring the sample size. So the window stays at 10 m and
// its outer half is thinned, which costs some evenness (the thinning drops a
// rank-ordered subset, and no low-discrepancy sequence survives that intact) and
// still leaves the real bed 1.3x the control. Near is also where the complaint
// was.
{
  const HALF = 10 // metres either side of the origin
  const pts = []
  const m = new THREE.Matrix4()
  for (const tile of strips.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      strips.batch.getMatrixAt(tile.ids[k], m)
      const px = m.elements[12]
      const pz = m.elements[14]
      if (Math.abs(px) <= HALF && Math.abs(pz) <= HALF) pts.push(px, pz)
    }
  }
  const meanNN = (a) => {
    const n = a.length / 2
    let sum = 0
    for (let i = 0; i < n; i++) {
      let best = Infinity
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = a[i * 2] - a[j * 2]
        const dz = a[i * 2 + 1] - a[j * 2 + 1]
        const d2 = dx * dx + dz * dz
        if (d2 < best) best = d2
      }
      sum += Math.sqrt(best)
    }
    return sum / n
  }
  const n = pts.length / 2
  // The control: the same count of points over the same box, uniform. Same
  // count and same box, so the two means are directly comparable.
  const ctrl = new Float64Array(n * 2)
  let cs = 0x9e3779b9
  const cr = () => {
    cs = (cs + 0x6d2b79f5) | 0
    let t = Math.imul(cs ^ (cs >>> 15), 1 | cs)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < n * 2; i++) ctrl[i] = (cr() * 2 - 1) * HALF
  const nnStrip = meanNN(pts)
  const nnCtrl = meanNN(ctrl)
  // Poisson's own answer, as a check that the control is behaving.
  const poisson = 0.5 / Math.sqrt(n / (4 * HALF * HALF))
  check(n > 300 && Math.abs(nnCtrl / poisson - 1) < 0.12,
    'the uniform control scatters the way Poisson says it should',
    `${nnCtrl.toFixed(3)} m vs 0.5/sqrt(density) = ${poisson.toFixed(3)} m, ${n} points`)
  check(nnStrip / nnCtrl > 1.3,
    'and the real scatter spreads further than that, which is the whole point of R2',
    `${nnStrip.toFixed(3)} m vs ${nnCtrl.toFixed(3)} m uniform (${(nnStrip / nnCtrl).toFixed(2)}x)`)
}

// A TILE IS A WHOLE NUMBER OF ITS OWN ASPECT, AND THE TWIST IS AN ANGLE. The
// fragment stage
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
  let worstLean = Infinity
  let bestLean = 0
  const twistTan = getStripTiling().twist.map((d) => Math.tan((d * Math.PI) / 180))
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
      worstAspect = Math.max(worstAspect, Math.abs(tileW / tileH / STRIP_TILE_ASPECT - 1))
      // ...and the twist, which is the same class of bug waiting to happen. The
      // shader displaces the top corner in LOCAL z, which the matrix scales by
      // s3.x (the long axis, because the strip's scale is (sx, sy, sx)), so the
      // lean would run from 3 degrees on a short strip to 30 on a long one if the
      // shader did not divide it back out by sx/sy. This replays that arithmetic
      // against the real matrix and measures the angle IN METRES, which is the
      // only place the mistake would ever have shown.
      const stScale = s3.x / s3.y
      for (const t of [twistTan[0], twistTan[1]]) {
        const dz = ((t * STRIP_BASE.height) / stScale) * s3.x
        const dy = STRIP_BASE.height * s3.y
        const deg = (Math.atan2(dz, dy) * 180) / Math.PI
        worstLean = Math.min(worstLean, deg)
        bestLean = Math.max(bestLean, deg)
      }
      seen.set(Math.round(count), (seen.get(Math.round(count)) ?? 0) + 1)
      n++
    }
  }
  const counts = [...seen.keys()].sort((a, b) => a - b)
  check(n > 100 && worstFrac < 1e-4, 'every strip is a whole number of clumps long',
    `worst ${worstFrac.toExponential(1)} of a clump over ${n} strips`)
  check(worstAspect < 1e-4, 'and every clump keeps the tuft card\'s aspect, not stretched along the strip',
    `worst aspect error ${worstAspect.toExponential(1)}`)
  const [twLo, twHi] = getStripTiling().twist
  check(Math.abs(worstLean - twLo) < 0.01 && Math.abs(bestLean - twHi) < 0.01,
    'and the twist is the same angle on a short strip as on a long one',
    `${worstLean.toFixed(1)}-${bestLean.toFixed(1)} deg in metres, asked for ${twLo}-${twHi}`)
  check(counts[0] === STRIP_TILES[0] && counts[counts.length - 1] === STRIP_TILES[1]
    && counts.length === STRIP_TILES[1] - STRIP_TILES[0] + 1,
    'and the whole of STRIP_TILES is drawn from, which is where the variety now comes from',
    counts.map((c) => `${c}:${((seen.get(c) / n) * 100).toFixed(0)}%`).join(' '))
}
check(ss.tris === (ss.placed - ss.rimHidden) * 2, 'every drawn strip costs exactly two triangles',
  `${(ss.tris / 1000).toFixed(1)}k`)
// The whole claim, end to end and measured rather than derived.
//
// PER INSTANCE THE TWO ARE NOW LEVEL, and that is the interesting half. The
// strip's original argument was that it is two flat triangles where a tuft
// averages a 6-and-2 ladder; the tuft bed has no ladder any more, so both beds
// are exactly two triangles an instance and the strip's remaining win is
// entirely in how many instances it puts down. Gated as EQUAL rather than
// deleted, because a tuft bill that climbs off 2.00 means a ladder came back on
// a mesh that cannot hold one.
const tuftPer = st.tris / (st.placed - st.rimHidden)
const stripPer = ss.tris / (ss.placed - ss.rimHidden)
check(stripPer === 2 && tuftPer === 2, 'a strip and a tuft cost the same two triangles',
  `${stripPer.toFixed(2)} tri vs ${tuftPer.toFixed(2)}`)
check(ss.tris < st.tris, `and at STRIP_MATCH = ${STRIP_MATCH} the whole carpet is cheaper too`,
  `${(ss.tris / 1000).toFixed(1)}k vs ${(st.tris / 1000).toFixed(1)}k ` +
  `(${(ss.tris / st.tris).toFixed(2)}x)`)

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

// --- 12. the arena, and the far-field grow -----------------------------------
//
// The bed draws through InstancedArena, a BatchedMesh-shaped facade over
// THREE.InstancedMesh -- see THE ARENA IS AN InstancedMesh in render/grass.js for
// the measurement that put it there (5 fps batched, 50-60 fps instanced at three
// times the triangles, same headset, same bed). What is gated here is the part
// of that shape which is silent when it breaks:
//
//   HIDDEN MUST MEAN ZEROED. An InstancedMesh draws a contiguous `count` and has
//   no per-instance visibility, so the shim hides by writing a zero matrix and
//   keeps the real one in a shadow array. Two ways that breaks silently: a hidden
//   tuft whose matrix was never cleared draws at full size where the rim just
//   dissolved it, and a shown tuft whose matrix was never restored is a hole.
//   Both are invisible in Node except by asking, so this asks.
//
//   count MUST COVER EVERY VISIBLE ID. It is a high-water mark, and if it ever
//   lagged an id that was made visible, that tuft would silently not draw.
//
//   THE BILLBOARD MUST STAY CYLINDRICAL. Rocks are viewpoint-oriented and grass
//   is not: a spherical billboard tips the whole carpet to face an eye 1.6 m up,
//   which from any altitude reads as crop circles. It is one boolean in
//   createPropMaterial and it changes nothing that throws.
//
//   THE GROW MUST BE WIRED, AND WIRED IN THE VERTEX STAGE. Halving the far-field
//   density is only affordable because the survivors are twice the size out
//   there; a bed that lost the grow would be half the grass with nothing paying
//   it back, and the only visible symptom is "it looks thinner than it did".

console.log('\n-- arena --')
{
  check(grass.batch.isInstancedMesh === true && !grass.batch.isBatchedMesh,
    'the bed draws through an InstancedMesh, which is one hardware draw',
    `${grass.batch.constructor.name}, ${st.style}`)

  // THE MATERIAL, READ OFF THE PROGRAM CACHE KEY, which is the one string that
  // has to name every compile-time branch in the shader -- if a flag is missing
  // from it, two arenas share a program and the bug is far worse than this gate.
  // So checking it is checking the shader, not a label beside it.
  const key = grass.material.customProgramCacheKey()
  check(!key.includes('-sph'), 'and grass billboards cylindrically, not at the viewpoint', key)
  check(key.includes('-ifade'),
    'and its dissolve is compiled against the attribute, not a batch colour texture', key)
  check(key.includes(`-grow${GROW_FROM}.${GROW_TO}.${GROW_SCALE}.`),
    'and the far-field grow is compiled in', key)
  check(!key.includes('-nospin'), 'and the shipped bed does spin its cards', key)

  // THE BILLBOARD TOGGLE IS ONE VARIABLE, and this is the gate that says so.
  // main.js's `grass cards: billboard/fixed` row exists to price the spin, and
  // it can only do that if the spin is the ONLY thing it changes -- so the
  // no-spin build has to keep the grow ramp and the u-flip and drop nothing but
  // the yaw-to-camera rotate. Read off the compiled GLSL rather than the flag,
  // because the failure this guards against is a flag that stops reaching the
  // shader, which no amount of reading the flag can find.
  {
    const CHUNKS = ['common', 'begin_vertex', 'project_vertex']
    const compile = (m) => {
      const shader = {
        uniforms: {},
        vertexShader: CHUNKS.map((c) => `#include <${c}>`).join('\n'),
        fragmentShader: '#include <common>\n#include <color_fragment>\n#include <normal_fragment_begin>\n'
          + 'vec4 diffuseColor = vec4( diffuse, opacity );',
      }
      m.onBeforeCompile(shader)
      return m.userData.shader.vertexShader
    }
    const fixed = new Grass(new THREE.Scene(), flat, dry, clear, texArray,
      { seed: 7, style: 'tufts', spin: false })
    const spunSrc = compile(grass.material)
    const fixedSrc = compile(fixed.material)
    const ROTATE = 'transformed.x * bbC.x'
    const GROW = 'float bbG'
    const FLIP = 'vUvProj.x = 1.0 - vUvProj.x'
    check(spunSrc.includes(ROTATE) && !fixedSrc.includes(ROTATE),
      'and spin:false is the yaw-to-camera rotate gone from the compiled source',
      `rotate present ${spunSrc.includes(ROTATE)} -> ${fixedSrc.includes(ROTATE)}`)
    check(fixedSrc.includes(GROW) && fixedSrc.includes(FLIP),
      'and nothing else goes with it -- the grow ramp and the u-flip survive',
      `grow ${fixedSrc.includes(GROW)}, u-flip ${fixedSrc.includes(FLIP)}`)
    check(fixed.material.customProgramCacheKey().includes('-nospin'),
      'and the two builds cannot share a compiled program',
      fixed.material.customProgramCacheKey())
    fixed.dispose()
  }

  // The tuning itself, stated as the ask was: half the density, twice the size,
  // 30% underground. FULL_RADIUS is gated against its old value because the
  // halving is the whole reason the other three exist.
  check(FULL_RADIUS === 5 && GROW_SCALE > 1.6 && GROW_SINK === 0.3,
    'and the far field is half as dense, bigger, and 30% sunk',
    `F ${FULL_RADIUS} m, ${GROW_SCALE}x over ${GROW_FROM}-${GROW_TO} m, ${GROW_SINK * 100}% sunk`)
  // AND THE GROW DOES NOT SQUASH. The complaint that sent this constant here was
  // that the far field read as flat rectangles, which it did: the old form took
  // the width to GROW_SCALE and the visible height to GROW_SCALE * (1 - sink).
  // Both dimensions have to grow by the same factor for the bake's proportions
  // to survive the ramp, so assert the shader's two scales against each other
  // rather than the constant they are built from.
  {
    const t = 1
    const g = 1 + (GROW_SCALE - 1) * t
    const s = GROW_SINK * t
    const ys = g / (1 - s)
    // Visible height: the card's top lands at top * ys * (1 - s), its foot at a
    // negative y. Width is a flat g. The two must agree.
    const visible = ys * (1 - s)
    check(Math.abs(visible - g) < 1e-9,
      'and the grow keeps the card\'s proportions rather than flattening it',
      `width ${g.toFixed(3)}x, visible height ${visible.toFixed(3)}x, ${(s * 100).toFixed(0)}% buried`)
  }
  // The sink is a fraction of the CARD, resolved against the real geometry, so a
  // taller card sinks further and the buried fraction does not drift.
  {
    const geo = grass.batch.geometry
    geo.computeBoundingBox()
    check(near(geo.boundingBox.min.y, 0, 1e-6),
      'and the card stands on y = 0, which is what makes the sink a subtraction',
      `foot at ${geo.boundingBox.min.y.toFixed(6)} m`)
  }

  // NOW WALK IT, because a stationary bed never evicts, never regrows and never
  // re-shows an id the rim had hidden -- which is exactly where the shadow
  // matrix is load-bearing. Nothing below counts instances, so the wall-clock
  // regrow budget does not reach it.
  const walk = new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'tufts' })
  walk.place(0, 0)
  for (let f = 0; f <= RIM_PHASES; f++) {
    setPropClock(f * PROP_FADE_SECONDS)
    walk.update(0, EYE, 0)
  }
  for (let i = 1; i <= 40; i++) {
    setPropClock(((RIM_PHASES + i) * PROP_FADE_SECONDS) % 1024)
    walk.update(i * 2, EYE, i * 2)
  }
  let liveZero = 0
  let hiddenSet = 0
  let overCount = 0
  const m = walk.batch.instanceMatrix.array
  for (let i = 0; i < walk.maxInstances; i++) {
    // Element 15 is the homogeneous w, which is 1 in every matrix compose() can
    // produce and 0 only in the zeroed one -- so it alone separates the two.
    const zeroed = m[i * 16 + 15] === 0
    if (walk.batch.getVisibleAt(i)) {
      if (zeroed) liveZero++
      if (i >= walk.batch.count) overCount++
    } else if (!zeroed) hiddenSet++
  }
  check(liveZero === 0 && hiddenSet === 0,
    'a shown tuft carries its own matrix and a hidden one carries a zero',
    `${walk.maxInstances} instances, ${liveZero} shown-but-zeroed, ${hiddenSet} hidden-but-drawn`)
  check(overCount === 0 && walk.batch.count <= walk.maxInstances,
    'and the draw count reaches every visible one without reaching the whole pool',
    `count ${walk.batch.count} of ${walk.maxInstances}, ${overCount} visible past it`)
  // The pool has to survive the walk with room left. It is sized by _poolBound
  // from the same level table the tiles grow from, plus 35%, and the margin is
  // what absorbs a camera standing off-centre in its tile grid while eviction
  // lags a tile and a half behind the draw radius.
  const used = walk.maxInstances - walk.freeCount
  check(used < walk.maxInstances * 0.9, 'and the pool still has room after 113 m of walking',
    `${used} of ${walk.maxInstances} held`)
  setPropClock(0)
  walk.dispose()
}

grass.dispose()

// --- 8. the blade bed -------------------------------------------------------

console.log('\n-- blades --')

{
  const { BLADE_DENSITY, BLADE_FULL_RADIUS, BLADE_DRAW_RADIUS, BLADE_FALLOFF,
    BLADE_SCALE } = GRASS_TUNING

  // The ground colour, as a function of position and nothing else, so an
  // instance tint can be checked against the exact spot its clump stands on.
  const groundOf = (x, z) => [0.5 + 0.4 * Math.sin(x), 0.5 + 0.4 * Math.sin(z), 0.25]
  const tint = {
    groundAt: (rgb, x, z) => { rgb.set(groundOf(x, z)); return rgb },
  }
  const bladeBed = (opts = {}) => {
    const g = new Grass(new THREE.Scene(), flat, dry, clear, texArray,
      { seed: 7, style: 'blades', tint, ...opts })
    g.place(0, 0)
    for (let i = 0; i < RIM_PHASES; i++) g.update(0, EYE, 0)
    return g
  }

  // A BLADE TAKES ITS COLOUR FROM THE GROUND, so a bed with no ground to ask is
  // not a bed with grey grass -- it is a caller who forgot an argument, and it
  // has to say so at construction rather than 20 m into a walk.
  let threw = false
  try {
    new Grass(new THREE.Scene(), flat, dry, clear, texArray, { seed: 7, style: 'blades' })
  } catch { threw = true }
  check(threw, 'blades without a terrain tint throw rather than rendering grey')

  const blades = bladeBed()
  const bs = blades.stats

  check(bs.style === 'blades' && blades.density === BLADE_DENSITY
    && blades.fullRadius === BLADE_FULL_RADIUS && blades.radius === BLADE_DRAW_RADIUS
    && blades.falloff === BLADE_FALLOFF,
  'the shipped bed stands at the tuned knobs',
  `${blades.density}/m2, full ${blades.fullRadius} m, cull ${blades.radius} m, p ${blades.falloff}`)

  // THE THINNING LAW, `keep = min(1, F/d)^p`, sampled either side of F. This is
  // the only definition of the bill: _growTile grows from it, _thin cuts to it
  // and _poolBound sizes from it, so a change here is a change to every one.
  {
    let worst = 0
    for (const p of [0.5, 1, 2, 3]) {
      const g = new Grass(new THREE.Scene(), flat, dry, clear, texArray,
        { seed: 7, style: 'blades', tint, falloff: p })
      for (let d = 0.25; d <= g.radius; d += 0.25) {
        const want = Math.pow(Math.min(1, g.fullRadius / d), p)
        worst = Math.max(worst, Math.abs(g._keepAt(d) - want))
      }
      g.dispose()
    }
    check(worst < 1e-12, 'and thins as (F/d)^p outside F, flat at 1 inside it',
      `worst ${worst.toExponential(1)} over p = 0.5, 1, 2, 3`)
  }

  // MORE CULLED AT DISTANCE, BUT NEVER ALL OF IT -- the point of the exponent.
  // A steeper p leaves a smaller share standing at every distance past F and
  // still leaves something standing at the cull radius, which is what separates
  // "thin the far field" from "shrink the draw radius".
  {
    const R = blades.radius
    const F = blades.fullRadius
    const keep = (p, d) => Math.pow(Math.min(1, F / d), p)
    check(keep(3, R) > 0 && keep(3, R) < keep(1, R) / 10,
      'and a steeper exponent empties the far field without ever emptying it',
      `at ${R} m: p=1 keeps ${(keep(1, R) * 100).toFixed(1)}%, p=3 keeps ${(keep(3, R) * 100).toFixed(2)}%`)
    // Against a SHALLOWER bed, because the shipped one is already the steep end
    // of the row -- comparing it to itself would pass on any knob at all.
    const shallow = bladeBed({ falloff: 1 })
    check(blades.stats.placed < shallow.stats.placed * 0.5 && blades.stats.placed > 0,
      'and the knob reaches the scatter, not just the arithmetic',
      `${blades.stats.placed} clumps at p=${blades.falloff} vs ${shallow.stats.placed} at p=1`)
    shallow.dispose()
  }

  // A CLUMP IS A BUNDLE OF PLANTS, NOT A PICTURE OF ONE, so its size roll scales
  // all three axes alike -- the card bed's sqrt on xz would turn a small roll
  // into a squat bundle instead of a small one.
  {
    let worst = 0
    let sampled = 0
    let lo = Infinity
    let hi = 0
    const m = blades.batch.instanceMatrix.array
    for (let i = 0; i < blades.batch.count && sampled < 500; i++) {
      if (!blades.batch.getVisibleAt(i)) continue
      const o = i * 16
      const sx = Math.hypot(m[o], m[o + 1], m[o + 2])
      const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6])
      worst = Math.max(worst, Math.abs(sx / sy - 1))
      lo = Math.min(lo, sy)
      hi = Math.max(hi, sy)
      sampled++
    }
    check(sampled > 0 && worst < 1e-5, 'a clump scales uniformly rather than squatting',
      `worst xz/y ${worst.toExponential(1)} over ${sampled} clumps`)
    check(lo >= BLADE_SCALE[0] - 1e-6 && hi <= BLADE_SCALE[1] + 1e-6,
      'and stays inside BLADE_SCALE',
      `${lo.toFixed(3)}x - ${hi.toFixed(3)}x of ${BLADE_SCALE.join('-')}`)
  }

  // THE TIP MULTIPLIER IS PER INSTANCE AND LIVES ON THE GEOMETRY. An
  // InstancedBufferAttribute is read per instance but is held by the geometry,
  // not the mesh, so the arena has to hang it on the CLONE it drew from -- put it
  // on the source and every instance reads element 0.
  {
    const attr = blades.batch.geometry.getAttribute('aTipMul')
    check(attr && attr.isInstancedBufferAttribute && attr.itemSize === 1,
      'the tip multiplier rides an instanced attribute on the drawn geometry',
      attr ? `${attr.array.length} slots, itemSize ${attr.itemSize}` : 'missing')
    const set = new Set()
    let outOfRange = 0
    for (let i = 0; attr && i < blades.batch.count; i++) {
      if (!blades.batch.getVisibleAt(i)) continue
      const v = attr.array[i]
      set.add(Math.round(v * 1e4))
      if (!(v > 0)) outOfRange++
    }
    check(set.size > 100 && outOfRange === 0,
      'and every clump rolls its own, so the bed is not one plant repeated',
      `${set.size} distinct values, ${outOfRange} non-positive`)
  }

  // EVERY CLUMP IS THE COLOUR OF THE DIRT IT GREW OUT OF. The blade's foot
  // vertices are (1,1,1), so the instance colour lands on them untouched and the
  // meadow reads as the terrain growing rather than a green rug laid over it.
  {
    let worst = 0
    let sampled = 0
    const c = blades.batch.instanceColor.array
    for (let i = 0; i < blades.batch.count && sampled < 500; i++) {
      if (!blades.batch.getVisibleAt(i)) continue
      const want = groundOf(blades.instX[i], blades.instZ[i])
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(c[i * 3 + k] - want[k]))
      sampled++
    }
    check(sampled > 0 && worst < 1e-6, 'and wears the ground colour under its own feet',
      `worst channel ${worst.toExponential(1)} over ${sampled} clumps`)
  }

  // No impostor, because there is no card to bake one from -- the bed is opaque
  // geometry all the way to the cull radius, which is the point of it.
  check(blades.bakeCards() === null, 'a blade bed bakes no impostor card')

  // THE BILL. Ten opaque triangles a clump against the tuft bed's alpha-tested
  // two, so the trade only pays if the disc stays small: this is the number that
  // has to fit under the ceiling alongside the terrain and the forest.
  check(bs.tris < 200000, 'and the whole disc fits the triangle budget',
    `${Math.round(bs.tris / 1000)}k triangles, ${bs.placed} clumps at ${bs.density}/m2 to ${bs.radius} m`)

  blades.dispose()
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all grass checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
