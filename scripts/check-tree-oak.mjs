// Node-side gates for the oak generator (src/props/tree-oak.js).
//
//   node scripts/check-tree-oak.mjs [seeds]
//
// What this holds, in the order it would cost the most to lose:
//
//   THE PINE IS PINNED. tree-v8.js is the conifer generator and the bench that
//   hosts both now dispatches per species. Nothing here imports the oak into
//   the pine's path, but the fingerprint is the proof rather than the argument:
//   a hash over every attribute of every v8 species at every tier, against the
//   values recorded when the oak arrived.
//
//   THE LAW IS THE BUILDER. resolveTreeOak() prices a parameter set before any
//   geometry exists and the ladder table prints it; buildTreeOak() must emit
//   exactly that many triangles, at every tier and over every shape here.
//
//   A SCOOP IS A SCOOP. Five faces fanned one way round, so every face agrees
//   with the scoop's opening, which is turned away from the openings beside
//   it, with the body reaching any way but back down a limb at its tip; the
//   normals on the scoop's sky side and smooth across it; the stem corner on
//   the wood's surface, the bole's tip included, and, on the whole, further
//   from the centre than the other four.
//
//   THE TIERS ARE ONE TREE. A coarse rung's scoops are a prefix of LOD0's,
//   each cut to a quad on three of LOD0's own corners, to the float in place
//   and in shade: dropped and flattened, not re-rolled, and at the same scale.
//
//   THE SHADE IS THE SKY. The crown's top and the foot of the bole are lit in
//   full and the bole under the crown is not.
//
//   THE LAYOUTS MATCH THE MATERIALS. The wood is createPropMaterial's layout
//   with its colour on and the crown is the mapped Lambert's, and BatchedMesh
//   refuses a batch over one stray attribute.

import { createHash } from 'node:crypto'

import {
  buildTreeOak, resolveTreeOak, treeOakLod, TREE_OAK_DEFAULTS, TREE_OAK_SPECIES, treeOakSpecies,
} from '../src/props/tree-oak.js'
import { buildTrunkV8, buildFoliageV8, treeV8Lod, treeV8Species, TREE_V8_SPECIES } from '../src/props/tree-v8.js'

const SEEDS = Number(process.argv[2] ?? 40)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- 1. the pine is pinned ---------------------------------------------------
//
// Recorded from tree-v8.js, `hem` on the foliage included: the fingerprint is
// every attribute, and a generator that grows one changes it as surely as a
// moved vertex does. A change to these is a change to a tree the user called
// dialed; the gate does not decide whether it was wanted, it only makes sure
// nobody finds out on the stage.
const V8_PINS = {
  'pine:0': 'trunk=1ef594f423802cac foliage=aa8164ef65564095 tris=352',
  'pine:1': 'trunk=b83848a437413be2 foliage=e362a69c90e746f8 tris=201',
  'pine:2': 'trunk=b83848a437413be2 foliage=5a898bf7a2562e24 tris=129',
  'oak:0': 'trunk=be27625b78491d16 foliage=c68dbb520ea6c27f tris=432',
  'oak:1': 'trunk=0fd6881c2ed9fee0 foliage=94cf8605ccf099fb tris=219',
  'oak:2': 'trunk=0fd6881c2ed9fee0 foliage=b6de989ba4754c80 tris=75',
  'aspen:0': 'trunk=c18cec8e2511e4c2 foliage=c732bed903fb96e7 tris=433',
  'aspen:1': 'trunk=aeb3af654e8f9cb3 foliage=06996c6f0ab752fb tris=243',
  'aspen:2': 'trunk=aeb3af654e8f9cb3 foliage=f993b6f2e6d5c7a5 tris=111',
  'birch:0': 'trunk=272bc8a31ef615da foliage=76628008664a8582 tris=413',
  'birch:1': 'trunk=1955d9b4e256d7e6 foliage=b619e8be0261c09e tris=219',
  'birch:2': 'trunk=1955d9b4e256d7e6 foliage=b4a40f6ef4bf4bf4 tris=93',
}

function fingerprint(geo) {
  const h = createHash('sha256')
  for (const name of Object.keys(geo.attributes).sort()) {
    h.update(name)
    h.update(Buffer.from(geo.attributes[name].array.buffer))
  }
  if (geo.index) h.update(Buffer.from(geo.index.array.buffer))
  return h.digest('hex').slice(0, 16)
}

console.log('--- 1. the v8 species are pinned')
for (const name of Object.keys(TREE_V8_SPECIES)) {
  for (let tier = 0; tier < 3; tier++) {
    const p = treeV8Lod(treeV8Species(name), tier)
    const { geometry: trunk, frame, tree } = buildTrunkV8(p)
    const foliage = buildFoliageV8(p, frame)
    const got = `trunk=${fingerprint(trunk)} foliage=${fingerprint(foliage)} tris=${tree.triangles + foliage.userData.foliage.triangles}`
    check(got === V8_PINS[`${name}:${tier}`], `${name} LOD${tier} unchanged`, got === V8_PINS[`${name}:${tier}`] ? '' : `got ${got}`)
  }
}

// --- the shapes ---------------------------------------------------------------
const SHAPES = [
  { name: 'default', over: {} },
  { name: 'straight', over: { trunkSegments: 1, branchSegments: 1, trunkCrook: 0, branchCrook: 0 } },
  { name: 'gnarled', over: { trunkSegments: 6, trunkCrook: 0.4, branchSegments: 6, branchCrook: 0.7, branchRise: -0.2 } },
  { name: 'bare', over: { branches: 0 } },
  { name: 'flat', over: { boughDepth: 0, boughSkew: 0, boughJitter: 0, tipZone: 0 } },
  { name: 'tips', over: { tipZone: 1 } },
  { name: 'capped', over: { tipBoughs: 8, tipZone: 0 } },
  { name: 'uncapped', over: { tipBoughs: 0 } },
  { name: 'plain', over: { boughAims: 1, boughSpins: 1 } },
  { name: 'many', over: { branches: 11, boughs: 160, boughRadius: 0.04, tipBias: 0.5 } },
  { name: 'round', over: { trunkLobe: 0, trunkSides: 5, branchSides: 3 } },
  { name: 'tiny', over: { height: 1.2, boughs: 12 } },
  { name: 'fat', over: { trunkRadius: 0.09, branchRadius: 1, boughDepth: 1.2, boughAims: 64, boughSpins: 12, stemReach: 3 } },
  { name: 'cups', over: { boughDepth: 1, boughSkew: 0.9, boughJitter: 0.6, stemReach: 0.3, boughFrom: 0.9 } },
  { name: 'aspen', over: TREE_OAK_SPECIES.aspen.params },
  { name: 'birch', over: TREE_OAK_SPECIES.birch.params },
]

// The unwelded crown is fifteen vertices a scoop, in the fan's order: face k
// is (centre, rim k, rim k + 1), and rim 0 is the stem.
const PER_SCOOP = 15
const scoopVerts = (pos, i) => {
  const v = (k) => [pos[(i * PER_SCOOP + k) * 3], pos[(i * PER_SCOOP + k) * 3 + 1], pos[(i * PER_SCOOP + k) * 3 + 2]]
  return { centre: v(0), stem: v(1), rim: [v(2), v(5), v(8), v(11)] }
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// --- 2. the law is the builder ----------------------------------------------
console.log('--- 2. resolveTreeOak() prices what buildTreeOak() builds')
{
  let worst = ''
  let n = 0
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      for (let tier = 0; tier < 3; tier++) {
        const p = treeOakLod({ ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }, tier)
        const r = resolveTreeOak(p)
        const { trunk, foliage, stats } = buildTreeOak(p)
        const idx = trunk.index.count / 3 + foliage.index.count / 3
        const wood = trunk.index.count / 3
        n++
        if (idx !== r.triangles || stats.triangles !== r.triangles || wood !== r.woodTris || stats.woodTris !== r.woodTris) {
          worst = worst || `${shape.name} seed ${1000 + s} LOD${tier}: law ${r.triangles} (wood ${r.woodTris}), index ${idx} (wood ${wood}), stats ${stats.triangles}`
        }
      }
    }
  }
  check(worst === '', `index count == law over ${n} builds`, worst)
}

// --- 3. a scoop is a scoop --------------------------------------------------
//
// The fan goes one way round, so every face's own cross product must have a
// positive part along the scoop's opening -- a face against it is one the
// skew or the jitter turned over. The opening is read off the fan itself: the
// SUM of the unnormalised cross products is twice the rim polygon's vector
// area, which lies along the opening exactly, where a mean of unit normals
// does not -- a deep cup's opposite walls cancel. The stored normals sit on
// ONE side of the scoop, the sky's, each rim corner's leaning to its own
// face's side of the sheet, and they are smooth: a corner shared by two faces carries one
// normal in both, and on any scoop with depth to it that normal is not the
// face's own. The bodies reach every way: with every scoop in the tip zone
// none runs back down its limb, and over all the shapes only a few reach
// straight out along the limb -- the litter is not a clamshell of scoops
// closing on each tip. The aim's whole point is measured too: over scoops
// within three rim radii of one another, the mean of how parallel two
// openings are must come out clearly lower with the aim on than with a single
// candidate (`plain`). The stem is on the wood's surface, the bole's included:
// within the tube's radius of its polyline, read back off the wood's own
// rings. And, in all but a few, the stem is further from the centre than the
// other rim corners.
console.log('--- 3. every scoop is fanned one way, shaded smooth on its sky side, aimed off its neighbours, stemmed on the wood and reaches off it')
{
  let faces = 0
  let against = 0
  let notOwn = 0
  let notSmooth = 0
  let flat = 0
  let notReaching = 0
  let straightOut = 0
  let scoops = 0
  let reaching = 0
  let stemNear = 0
  let offWood = 0
  let worst = ''
  let worstSmooth = ''
  let worstWood = ''
  const parallel = { default: { sum: 0, pairs: 0 }, plain: { sum: 0, pairs: 0 } }
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const p = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const r = resolveTreeOak(p)
      const { trunk, foliage } = buildTreeOak(p)
      const pos = foliage.attributes.position.array
      const nrm = foliage.attributes.normal.array
      // The polylines and ring radii, off the wood: the bole's rings and apex
      // first, then each branch's. A ring's mean is its centre, a seam corner
      // over, and a lobed bole's mean radius is its round one.
      const wood = trunk.attributes.position.array
      let at = 0
      const limbs = []
      const readTube = (segments, sides) => {
        const path = []
        const radii = []
        for (let ring = 0; ring < segments; ring++) {
          let cx = 0, cy = 0, cz = 0
          const n = sides + 1
          for (let k = 0; k < n; k++) { cx += wood[(at + k) * 3]; cy += wood[(at + k) * 3 + 1]; cz += wood[(at + k) * 3 + 2] }
          const c = [cx / n, cy / n, cz / n]
          let rad = 0
          for (let k = 0; k < n; k++) rad += dist(c, [wood[(at + k) * 3], wood[(at + k) * 3 + 1], wood[(at + k) * 3 + 2]])
          path.push(c)
          radii.push(rad / n)
          at += n
        }
        path.push([wood[at * 3], wood[at * 3 + 1], wood[at * 3 + 2]])
        radii.push(0)
        at += sides
        limbs.push({ path, radii })
      }
      readTube(r.trunkSegments, r.trunkSides)
      for (let b = 0; b < r.branches; b++) readTube(r.branchSegments, r.branchSides)
      // How far a point is off the nearest tube surface, in that branch's butt
      // radii: distance to the closest polyline segment, less the radius there;
      // and which way every segment whose surface it is on runs -- at a sharp
      // joint a stem sits on two, and it is the seat's own that it reaches
      // along.
      const nearestWood = (q) => {
        let best = Infinity
        const alongs = []
        for (const limb of limbs) {
          for (let i = 0; i + 1 < limb.path.length; i++) {
            const a = limb.path[i], b = limb.path[i + 1]
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
            const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
            const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / len2))
            const on = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
            const rad = limb.radii[i] + (limb.radii[i + 1] - limb.radii[i]) * t
            const off = Math.abs(dist(q, on) - rad) / limb.radii[0]
            best = Math.min(best, off)
            if (off <= 0.3) alongs.push(ab.map((v) => v / Math.sqrt(len2)))
          }
        }
        return { off: best, alongs }
      }
      const openings = []
      for (let i = 0; i < r.boughs; i++) {
        scoops++
        const { centre, stem, rim } = scoopVerts(pos, i)
        // Own cross products, unnormalised, and their sum: the opening.
        const own = []
        for (let f = 0; f < 5; f++) {
          const v = (i * 5 + f) * 3
          const ax = pos[(v + 1) * 3] - pos[v * 3], ay = pos[(v + 1) * 3 + 1] - pos[v * 3 + 1], az = pos[(v + 1) * 3 + 2] - pos[v * 3 + 2]
          const bx = pos[(v + 2) * 3] - pos[v * 3], by = pos[(v + 2) * 3 + 1] - pos[v * 3 + 1], bz = pos[(v + 2) * 3 + 2] - pos[v * 3 + 2]
          own.push([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx])
        }
        const opening = own.reduce((m, w) => [m[0] + w[0], m[1] + w[1], m[2] + w[2]], [0, 0, 0])
        // The stored normals, fifteen in the fan's order, and the scoop's sky
        // side: the way its centre normal leans off the opening. A vertex
        // whose normal is not on that side is wrongly lit, and so is a rim
        // corner leaning away from its own face's side of the sheet; the
        // centre of a deep cup legitimately leans off its steepest wall. A
        // sky side pointing down is upside down.
        const stored = (k) => [nrm[(i * PER_SCOOP + k) * 3], nrm[(i * PER_SCOOP + k) * 3 + 1], nrm[(i * PER_SCOOP + k) * 3 + 2]]
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        const sky = Math.sign(dot(stored(0), opening))
        if (sky * opening[1] < 0) { notOwn++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} normals on the ground side` }
        let flatFaces = 0
        for (let f = 0; f < 5; f++) {
          faces++
          const w = own[f]
          const l = Math.hypot(...w)
          if (dot(w, opening) <= 0) { against++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} face ${f} turned over` }
          let ownFace = 0
          for (let m = 0; m < 3; m++) {
            const n = stored(f * 3 + m)
            const lean = (sky * dot(w, n)) / l
            if ((m > 0 && lean <= 0) || sky * dot(n, opening) <= 0) { notOwn++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} face ${f} vertex ${m} normal leans off its sky side` }
            if (lean > 0.999) ownFace++
          }
          if (ownFace === 3) flatFaces++
          // Rim corner f + 1 is this face's third vertex and the next face's
          // second; the centre is every face's first.
          const g = (f + 1) % 5
          if (dist(stored(f * 3 + 2), stored(g * 3 + 1)) > 1e-6 || dist(stored(f * 3), stored(g * 3)) > 1e-6) { notSmooth++; worstSmooth = worstSmooth || `${shape.name} seed ${1000 + s} scoop ${i} faces ${f} and ${g} disagree on a shared corner` }
        }
        if (p.boughDepth > 0 && flatFaces === 5) { flat++; worstSmooth = worstSmooth || `${shape.name} seed ${1000 + s} scoop ${i} is flat-shaded` }
        // The rim's centre, for the neighbourhood the aim scores.
        const rimC = [stem, ...rim].reduce((m, q) => [m[0] + q[0] / 5, m[1] + q[1] / 5, m[2] + q[2] / 5], [0, 0, 0])
        const l = Math.hypot(...opening)
        openings.push({ c: rimC, n: [opening[0] / l, opening[1] / l, opening[2] / l] })
        const { off, alongs } = nearestWood(stem)
        if (off > 0.3) { offWood++; worstWood = worstWood || `${shape.name} seed ${1000 + s} scoop ${i}: stem ${off.toFixed(2)} butt radii off the wood`; continue }
        // The body: the rim's mean less the stem, which the skew and the
        // spin leave at the rim's centre and the jitter moves only a little.
        // Every scoop of `tips` is a tip scoop, and those must reach past the
        // limb, not back down it: the aim refuses a body behind the seat's
        // tangent, and a body square to it read through the jittered rim
        // comes out a little behind at most.
        const body = rim.reduce((m, q) => [m[0] + q[0] / 4, m[1] + q[1] / 4, m[2] + q[2] / 4], [0, 0, 0]).map((v, k) => v - stem[k])
        const forward = Math.max(...alongs.map((a) => (body[0] * a[0] + body[1] * a[1] + body[2] * a[2]) / Math.hypot(...body)))
        if (p.tipZone >= 1 && forward < -0.2) { notReaching++; worst = worst || `${shape.name} seed ${1000 + s} scoop ${i} at a tip runs back down the limb` }
        if (forward > Math.cos(Math.PI / 6)) straightOut++
        // `cups` puts the stem at a third of a rim radius on purpose; the
        // promise is for every shape that keeps the reach past one.
        if (p.stemReach > 1) {
          reaching++
          const others = rim.reduce((sum, q) => sum + dist(q, centre), 0) / rim.length
          if (dist(stem, centre) <= others) stemNear++
        }
      }
      if (shape.name in parallel) {
        // The aim's own neighbourhood: three rim radii, as the generator sizes
        // the rim before the rescale, which is within a few percent of one.
        const near = 3 * p.boughRadius * p.height
        const tally = parallel[shape.name]
        for (let i = 0; i < openings.length; i++) {
          for (let j = 0; j < i; j++) {
            const a = openings[i], b = openings[j]
            if (dist(a.c, b.c) >= near) continue
            tally.sum += Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2])
            tally.pairs++
          }
        }
      }
    }
  }
  check(against === 0 && notOwn === 0 && notReaching === 0, `${faces} faces: ${against} turned over, ${notOwn} vertices lit off their sky side; ${notReaching} tip scoops running back down the limb`, worst)
  check(notSmooth === 0 && flat === 0, `${scoops} scoops shaded smooth: ${notSmooth} corners disagreeing between faces, ${flat} scoops with depth shaded flat`, worstSmooth)
  // A body within thirty degrees of its limb's own heading: a cone of a
  // fifteenth of the sphere, so a litter reaching every way keeps well under a
  // fifth of its scoops there.
  check(straightOut < scoops * 0.2, `${straightOut} of ${scoops} scoops reach straight out along their limb`)
  const aimed = parallel.default.sum / parallel.default.pairs
  const plain = parallel.plain.sum / parallel.plain.pairs
  check(parallel.default.pairs > 0 && aimed < plain * 0.85, `neighbouring openings are less parallel aimed than not: ${aimed.toFixed(3)} against ${plain.toFixed(3)} over ${parallel.default.pairs} and ${parallel.plain.pairs} pairs`)
  check(offWood === 0, `${scoops} stems on the wood's surface`, worstWood)
  check(stemNear <= reaching * 0.01, `the stem is further from the centre than the other corners in all but ${stemNear} of ${reaching}`)
}

// --- 4. the tiers are one tree ----------------------------------------------
//
// A coarse rung's crown must be the first N scoops of LOD0's crown, each a
// quad of six unwelded vertices -- (stem, L, far), (stem, far, R) -- whose
// stem, L and R are LOD0's stem, first and last rim corners, in position and
// in shade: the seats are drawn the same, nothing is re-rolled, the extent
// that sets the scale is measured over every scoop drawn rather than over
// those kept, and the sky is cast against every scoop drawn, so the tiers
// share one scale and one bake to the float. LOD1 keeps every scoop. The quad
// itself is held to the pentagon's terms: both faces with its opening, the
// normals on its sky side and smooth across the fold.
console.log('--- 4. a coarse tier is LOD0\'s scoops cut to quads, at LOD0\'s scale and shade')
{
  let worst = 0
  let where = ''
  let counts = ''
  let quads = 0
  let bad = 0
  let worstQuad = ''
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const base = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const full = buildTreeOak(treeOakLod(base, 0)).foliage
      const a = full.attributes.position.array
      const ac = full.attributes.color.array
      const r0 = resolveTreeOak(treeOakLod(base, 0))
      for (let tier = 1; tier < 3; tier++) {
        const p = treeOakLod(base, tier)
        const r = resolveTreeOak(p)
        const cut = buildTreeOak(p).foliage
        const b = cut.attributes.position.array
        const bc = cut.attributes.color.array
        const bn = cut.attributes.normal.array
        if (b.length !== r.boughs * 6 * 3 || r.boughs > r0.boughs || (tier === 1 && r.boughs !== r0.boughs)) { counts = counts || `${shape.name} seed ${1000 + s} LOD${tier}: ${b.length / 3} vertices for ${r.boughs} scoops, LOD0 has ${r0.boughs}`; continue }
        for (let i = 0; i < r.boughs; i++) {
          for (const [k0, k1] of [[1, 0], [2, 1], [11, 5]]) {
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(a[(i * PER_SCOOP + k0) * 3 + c] - b[(i * 6 + k1) * 3 + c]) / base.height
              if (d > worst) { worst = d; where = `${shape.name} seed ${1000 + s} LOD${tier} scoop ${i}: ${(d * 100).toFixed(4)}% of height` }
            }
            const d = Math.abs(ac[(i * PER_SCOOP + k0) * 3] - bc[(i * 6 + k1) * 3])
            if (d > worst) { worst = d; where = `${shape.name} seed ${1000 + s} LOD${tier} scoop ${i}: shade off by ${d.toFixed(5)}` }
          }
          quads++
          const v = (k) => [b[(i * 6 + k) * 3], b[(i * 6 + k) * 3 + 1], b[(i * 6 + k) * 3 + 2]]
          const n = (k) => [bn[(i * 6 + k) * 3], bn[(i * 6 + k) * 3 + 1], bn[(i * 6 + k) * 3 + 2]]
          const cross = (o, p1, p2) => {
            const ax = p1[0] - o[0], ay = p1[1] - o[1], az = p1[2] - o[2]
            const bx = p2[0] - o[0], by = p2[1] - o[1], bz = p2[2] - o[2]
            return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]
          }
          const own = [cross(v(0), v(1), v(2)), cross(v(3), v(4), v(5))]
          const opening = [own[0][0] + own[1][0], own[0][1] + own[1][1], own[0][2] + own[1][2]]
          const sky = Math.sign(dot(n(0), opening))
          let ok = sky * opening[1] >= 0 && own.every((w) => dot(w, opening) > 0)
          for (let k = 0; k < 6; k++) if (sky * dot(n(k), opening) <= 0) ok = false
          // The stem is vertices 0 and 3, the far point 2 and 4: one normal each.
          if (dist(n(0), n(3)) > 1e-6 || dist(n(2), n(4)) > 1e-6) ok = false
          if (!ok) { bad++; worstQuad = worstQuad || `${shape.name} seed ${1000 + s} LOD${tier} scoop ${i}` }
        }
      }
    }
  }
  check(counts === '', 'LOD1 holds every scoop and LOD2 the kept count, six vertices each', counts)
  check(worst < 1e-6, 'every quad\'s stem and side corners are where LOD0 put them, at LOD0\'s shade', where ? `worst ${where}` : 'to the float')
  check(bad === 0, `${quads} quads fanned one way, shaded smooth on their sky side`, worstQuad)
}

// --- 5. the layouts ---------------------------------------------------------
console.log('--- 5. attribute layouts')
{
  const { trunk, foliage } = buildTreeOak(TREE_OAK_DEFAULTS)
  const keys = (g) => Object.keys(g.attributes).sort().join(',')
  check(keys(trunk) === 'color,normal,position,texLayer,uvProj', 'wood is createPropMaterial\'s layout with its colour on', keys(trunk))
  check(keys(foliage) === 'color,normal,position,uv', 'crown is {position, normal, uv, color}', keys(foliage))
  check(foliage.index !== null && foliage.index.count === foliage.attributes.position.count, 'crown carries an identity index')
  const col = foliage.attributes.color.array
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < col.length; i++) { lo = Math.min(lo, col[i]); hi = Math.max(hi, col[i]) }
  check(lo > 0.3 && hi <= 1.4 && lo < hi, 'the crown\'s shade is a grey in a sane range', `${lo.toFixed(2)}..${hi.toFixed(2)}`)
}

// --- 5b. the shade is the sky ----------------------------------------------
//
// Over the species: some scoop vertex sees the whole sky, the foot of the bole
// nearly does (birch's hanging limbs take a little of its sky), and the bole
// under the crown -- its highest ring, where every scoop is over it -- sees
// almost none. The foliage tint rides on top, so the crown's full is one plus
// the tint's half-range.
console.log('--- 5b. the crown\'s shell and the bole\'s foot are lit, the bole under the crown is not')
for (const name of Object.keys(TREE_OAK_SPECIES)) {
  const p = treeOakSpecies(name)
  const r = resolveTreeOak(p)
  const { trunk, foliage } = buildTreeOak(p)
  const inner = p.innerShade
  const leaf = foliage.attributes.color.array
  let crownHi = 0
  for (let i = 0; i < leaf.length; i += 3) crownHi = Math.max(crownHi, leaf[i])
  const wood = trunk.attributes.color.array
  const ring = (k) => {
    let sum = 0
    for (let i = 0; i <= r.trunkSides; i++) sum += wood[(k * (r.trunkSides + 1) + i) * 3]
    return sum / (r.trunkSides + 1)
  }
  const foot = ring(0)
  const neck = ring(r.trunkSegments - 1)
  check(crownHi >= 0.98, `${name}: the crown reaches full light`, `brightest ${crownHi.toFixed(3)}`)
  check(foot >= 0.9, `${name}: the foot of the bole sees the sky`, `foot ${foot.toFixed(3)}`)
  check(neck < inner + (1 - inner) * 0.35, `${name}: the bole under the crown is shaded`, `neck ${neck.toFixed(3)} against ${inner} at no sky`)
}

// --- 6. the tree stands at height ------------------------------------------
console.log('--- 6. the rescale lands the crown at height')
{
  let worst = 0
  let where = ''
  let below = 0
  for (const shape of SHAPES) {
    for (let s = 0; s < SEEDS; s++) {
      const p = { ...TREE_OAK_DEFAULTS, ...shape.over, seed: 1000 + s }
      const { stats } = buildTreeOak(p)
      const err = Math.abs(stats.height - p.height) / p.height
      if (err > worst) { worst = err; where = `${shape.name} seed ${1000 + s}: ${stats.height.toFixed(3)} for ${p.height}` }
      if (stats.belowGround > p.height * 0.25) below++
    }
  }
  // The extent is measured on the scoops' own vertices, so LOD0 lands on the
  // height to float noise; a coarse tier can fall short of it by whatever the
  // scoops it dropped reached, and that is section 4's promise, not this one's.
  check(worst < 1e-4, 'LOD0 stands at the height', where)
  check(below === 0, 'no shape puts more than a quarter of its height below ground', `${below} did`)
}

// --- 7. the bank ------------------------------------------------------------
console.log('--- 7. the species bank')
check(['oak', 'aspen', 'birch'].every((name) => treeOakSpecies(name).height > 0 && TREE_OAK_SPECIES[name].mat.startsWith('/trees/mat_')), 'oak, aspen and birch resolve from the bank, each with a mat')
{
  let threw = false
  try { treeOakSpecies('yew') } catch { threw = true }
  check(threw, 'an unknown species throws')
  threw = false
  try { treeOakLod(TREE_OAK_DEFAULTS, 3) } catch { threw = true }
  check(threw, 'tier 3 is not a mesh tier')
}

console.log(failures === 0 ? '\nall oak gates pass' : `\n${failures} oak gate(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
