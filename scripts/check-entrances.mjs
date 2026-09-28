// Node-side gates for the leafkin village entrances (src/v2/render/entrances.js,
// DESIGN.md §30).
//
//   node scripts/check-entrances.mjs
//
// A mouth is a thing she walks into, so what is gated is the walk: a mouth
// point on dry level ground in front of a face with PROBE.wall of wall behind
// it, the hole proud of that stone and inside the arch, the arch upright
// with its passage on the face's normal, every site the same on a second boot
// to the bit, and a site's record kept across the layer losing and regrowing
// it. The world is check-rocks' flat forest: the real biome field over flat
// ground, so the hollow bed grows where the wood is deep and nowhere else.

import * as THREE from 'three'
import { Rocks } from '../src/v2/render/rocks.js'
import { OPEN, STONE, LeafkinGround } from '../src/v2/render/leafkin-ground.js'
import {
  Entrances, HOLE, SCREEN, SCREEN_POOL, MOUTH_HEIGHT_M, MOUTH_SINK_M, MOUTH_STEP_M, PORTAL, PROBE, RADIUS_M, RUNGS, holeBox, mouthBankFrom, wallReach,
} from '../src/v2/render/entrances.js'
import { PROP_STEPS, propReach } from '../src/v2/render/gen-props.js'
import { Trees } from '../src/v2/render/trees.js'
import { Ferns } from '../src/v2/render/ferns.js'
import { WALK, WalkSurface } from '../src/v2/walk.js'
import { LOCOMOTION, Player } from '../src/player.js'
import { buildTextureArray } from '../src/textures.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import { ROCK_LOD_AT } from '../src/props/rock.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const GROUND = 60
const field = {
  scatterAt: (x, z, cell, out) => { out.h = GROUND; out.tan = 0; return out },
  heightAt: () => GROUND,
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0 }),
  snowLineAt: () => 9999,
  bands: { altLo: 0, altSpan: 900 },
}
const water = { levelAt: () => null, isSubmerged: () => false, shoreDistAt: (x, z, reach) => reach }
const layers = { flattenAt: () => 0, dirtAt: () => 0, shoreAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

/** A world grown about (cx, cz): the rocks, the trees the screens' pines are planted in (never placed, so no wood of their own), and the entrances. */
const boot = (cx, cz, { seed = 7, radius = null } = {}) => {
  const rocks = new Rocks(new THREE.Scene(), field, water, layers, texArray, { seed })
  rocks.place(cx, cz)
  const scene = new THREE.Scene()
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed, plantRoom: SCREEN_POOL })
  const e = new Entrances(scene, field, water, rocks, { seed, radius, bank: mouthBankFrom(readShippedLadder('cave-mouth')), ground: new LeafkinGround({ field, water, rocks }), trees })
  e.place(cx, cz)
  return { rocks, e, scene, trees }
}

const out = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ox: 0, oz: 0, size: 0 }

// --- the sites --------------------------------------------------------------
//
// The rocks hold the spacing (check-rocks pins 100 m by the hollow bed's
// construction); what is new here is that a hollow the rocks grow is a mouth
// the layer seats, and where it puts it. Boots 600 m apart over a 2.7 km
// square, each reaching 450, gather every hollow the wood grows in it
// without asking a 48-mouth pool for more than a 300 m tiling can hold.
console.log('\nthe sites')
const all = new Map()
let blind = 0
let probed = true
for (const cz of [-900, -300, 300, 900]) {
  for (const cx of [-900, -300, 300, 900]) {
    const { rocks, e } = boot(cx, cz, { radius: 450 })
    const hollows = rocks.hollowsInto(cx - 450, cz - 450, cx + 450, cz + 450, new Float32Array(64 * 5))
    if (e.stats.placed + e.stats.blind !== hollows) probed = false
    blind += e.stats.blind
    for (const s of e.sites()) all.set(s.key, s)
  }
}
check(probed, 'every hollow the rocks grew about a boot was probed', `${all.size} mouths, ${blind} blind`)
const sites = [...all.values()]
check(sites.length >= 20, 'the square holds a village most tiles', `${sites.length} sites, ${blind} blind`)
check(blind === 0, 'and no hollow was refused a mouth on flat ground', `${blind} blind`)
let closest = Infinity
for (let i = 0; i < sites.length; i++) {
  for (let j = i + 1; j < sites.length; j++) closest = Math.min(closest, Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z))
}
check(closest >= 100, 'no two mouths within 100 m', `closest ${closest.toFixed(0)} m`)

// --- the hole is inside the ring ----------------------------------------------
//
// The outline's edges, sampled every centimetre, against the pick's own
// solid on the hole's plane: a point is inside the arch when a ray out of it
// along +X crosses the mesh an odd number of times. Every sample must be in
// stone at the plane the layer seats the hole on and a hair either side of
// it, and grown 1.5 cm about its centre the outline must still fit, so a
// vertex is not sitting on the ring's edge.
console.log('\nthe hole is inside the ring')
{
  const bank = mouthBankFrom(readShippedLadder('cave-mouth'))
  const g = bank.tiers[0].geometries[0]
  const pos = g.getAttribute('position').array
  const idx = g.index.array
  const crossings = (x, y, z) => {
    let n = 0
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
      const ay = pos[a + 1], az = pos[a + 2], by = pos[b + 1], bz = pos[b + 2], cy = pos[c + 1], cz = pos[c + 2]
      const d = (by - cy) * (az - cz) + (cz - bz) * (ay - cy)
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((by - cy) * (z - cz) + (cz - bz) * (y - cy)) / d
      const l2 = ((cy - ay) * (z - cz) + (az - cz) * (y - cy)) / d
      const l3 = 1 - l1 - l2
      if (l1 < 0 || l2 < 0 || l3 < 0) continue
      if (l1 * pos[a] + l2 * pos[b] + l3 * pos[c] > x) n++
    }
    return n
  }
  const solid = (plane, u, v) => crossings(plane / bank.scale, v / bank.scale, u / bank.scale) % 2 === 1
  const plane = MOUTH_SINK_M + HOLE.proud
  const edgeSamples = (outline) => {
    const out = []
    for (let i = 0; i < outline.length; i++) {
      const [u0, v0] = outline[i], [u1, v1] = outline[(i + 1) % outline.length]
      const n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 0.01))
      for (let k = 0; k < n; k++) out.push([u0 + (u1 - u0) * (k / n), v0 + (v1 - v0) * (k / n)])
    }
    return out
  }
  const open = (outline, at) => edgeSamples(outline).filter(([u, v]) => !solid(at, u, v))
  const vertices = HOLE.outline.filter(([u, v]) => !solid(plane, u, v))
  check(vertices.length === 0, `every outline vertex is in the ring's stone at the hole's plane, ${plane.toFixed(2)} m into the arch`, vertices.length ? `open at ${JSON.stringify(vertices)}` : `${HOLE.outline.length} vertices`)
  for (const at of [plane - 0.02, plane, plane + 0.02]) {
    const bad = open(HOLE.outline, at)
    check(bad.length === 0, `and every centimetre of its edges at ${at.toFixed(2)} m`, bad.length ? `${bad.length} open, first (${bad[0][0].toFixed(2)}, ${bad[0][1].toFixed(2)})` : `${edgeSamples(HOLE.outline).length} samples`)
  }
  const [u0, u1, v0, v1] = holeBox()
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2
  const grown = HOLE.outline.map(([u, v]) => { const l = Math.hypot(u - cu, v - cv); return [u + ((u - cu) / l) * 0.015, v + ((v - cv) / l) * 0.015] })
  const bad = open(grown, plane)
  check(bad.length === 0, 'grown 1.5 cm about its centre it still fits', bad.length ? `${bad.length} open, first (${bad[0][0].toFixed(2)}, ${bad[0][1].toFixed(2)})` : '')
  const shrunk = HOLE.outline.map(([u, v]) => [cu + (u - cu) * 0.6, cv + (v - cv) * 0.6])
  check(open(shrunk, plane).length > 0, 'and shrunk to 0.6 it does not, so the test can fail', '')
}

// --- the face ---------------------------------------------------------------
//
// From the mouth point, looking along -n: the stone is MOUTH_STEP_M away, a
// wall for PROBE.wall above the eye, and its normal is within PROBE.faceDeg of
// the plane. Then the hole: a ray from the mouth point to the centre of its
// outline's box meets the hole before the stone, and one to each corner too.
console.log('\nthe face')
{
  const { rocks, e, trees } = boot(-900, -900, { radius: 450 })
  const rows = e.sites()
  let faced = 0, walled = 0, holed = 0, arched = 0
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const m = new THREE.Matrix4()
  for (const site of rows) {
    const { x, y, z, nx, nz } = site
    check(Math.abs(Math.hypot(nx, nz) - 1) < 1e-5, `site ${site.key}: the normal is a unit vector in the plane`)
    const t = rocks.hollowRayAt(x, y + PROBE.eye, z, -nx, 0, -nz, 4, out)
    const flat = Math.abs(out.ny) <= Math.sin((PROBE.faceDeg * Math.PI) / 180)
    faced += t < wallReach() && flat ? 1 : 0
    walled += rocks.hollowRayAt(x, y + PROBE.eye + PROBE.wall, z, -nx, 0, -nz, wallReach(), out) < Infinity ? 1 : 0
    // The hole, off the layer's own matrix: the centre and corners of its
    // outline's box in the world, each a ray target from the mouth point.
    m.fromArray(e.holeM, site.id * 16)
    m.decompose(p, q, s)
    const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const up = new THREE.Vector3(0, 1, 0)
    const [u0, u1, v0, v1] = holeBox()
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2
    let ok = 0
    for (const [u, v] of [[um, vm], [u0, v0], [u1, v0], [u0, v1], [u1, v1]]) {
      const c = p.clone().addScaledVector(across, um + (u - um) * 0.9).addScaledVector(up, vm + (v - vm) * 0.9)
      const d = c.clone().sub(new THREE.Vector3(x, y + 0.5, z))
      const len = d.length()
      d.divideScalar(len)
      const t = rocks.hollowRayAt(x, y + 0.5, z, d.x, d.y, d.z, len + 2, out)
      if (t > len) ok++
    }
    holed += ok === 5 ? 1 : 0
    // The arch stands upright at the site's floor with its X on the normal.
    e.batch.getMatrixAt(site.id, m)
    m.decompose(p, q, s)
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const aligned = Math.abs(ax.x * nx + ax.z * nz - 1) < 1e-4 && ay.y > 0.9999
    const seated = Math.abs(p.y - (GROUND - 0.05)) < 1e-4 && Math.abs(s.y * (MOUTH_HEIGHT_M / e.bank.scale) - MOUTH_HEIGHT_M) < 1e-6
    arched += aligned && seated ? 1 : 0
  }
  check(faced === rows.length, 'every mouth point looks at a face within 20 deg of vertical, within reach', `${faced}/${rows.length}`)
  check(walled === rows.length, `and at ${PROBE.wall} m of wall above it`, `${walled}/${rows.length}`)
  check(holed === rows.length, 'the hole stands proud of the stone at its centre and its corners', `${holed}/${rows.length}`)
  check(arched === rows.length, 'the arch stands upright on the floor, MOUTH_HEIGHT_M tall, its passage on the normal', `${arched}/${rows.length}`)
  const stepped = rows.every((site) => Math.hypot(site.x - site.ax, site.z - site.az) > MOUTH_STEP_M)
  check(stepped, 'the mouth point is outside the arch\'s centre', '')
  // The screen: SCREEN.count pieces of SCREEN.kinds, every stone stone to the
  // walker, every pine planted in the trees.
  let screened = 0, counted = 0, laid = 0, across = 0, climbed = 0, hidden = 0
  const kinds = Object.fromEntries(SCREEN.kinds.map((k) => [k, 0]))
  const col = new Float32Array(8)
  const eye = GROUND + LOCOMOTION.eyeHeight
  const [, , v0, v1] = holeBox()
  // Whether the eye's line from 40 m out, `deg` off the normal toward +u, to
  // the hole's middle passes within f's cover between its low and its top.
  const hides = (site, f, deg) => {
    const a = (deg * Math.PI) / 180
    const dx = site.nx * Math.cos(a) - site.nz * Math.sin(a), dz = site.nz * Math.cos(a) + site.nx * Math.sin(a)
    const vx = site.holeX + dx * 40, vz = site.holeZ + dz * 40
    const ex = site.holeX - vx, ez = site.holeZ - vz
    const t = Math.max(0, Math.min(1, ((f.x - vx) * ex + (f.z - vz) * ez) / (ex * ex + ez * ez)))
    const h = eye + (site.ay + 0.5 * (v0 + v1) - eye) * t
    return Math.hypot(vx + ex * t - f.x, vz + ez * t - f.z) < f.cover && h >= f.low && h <= f.top
  }
  for (const site of rows) {
    screened += site.screened ? 1 : 0
    counted += site.flank.length === SCREEN.count && site.flank.every((f) => f.kind in kinds) ? 1 : 0
    for (const f of site.flank) {
      kinds[f.kind]++
      if (f.kind === 'pine') continue
      const top = e.blockTopAt(f.x, f.z)
      const cols = e.columnAt(f.x, f.z, 0, col)
      if (cols >= 1 && Math.abs(top - col[1]) < 1e-3 && top > GROUND + 1 && Math.abs(top - f.top) < 0.25) climbed++
    }
    // The first piece beside the arch, the second beside it on the other side or before it.
    const u = site.flank.map((f) => (f.x - site.x) * -site.nz + (f.z - site.z) * site.nx)
    const beside = (k) => Math.abs(u[k]) > e.bank.width * 0.5
    const [a, b] = site.flank
    if (a && b && beside(0) && (beside(1) ? Math.sign(u[0]) !== Math.sign(u[1]) : true)) laid++
    across += b && beside(1) ? 1 : 0
    // A piece before the arch hides it straight on and 20 degrees either way;
    // one beside it, from 70 and 80 degrees off on its own side.
    const ok = site.flank.every((f, k) => (beside(k) ? [70, 80].map((d) => d * Math.sign(u[k])) : [-20, 0, 20]).every((d) => hides(site, f, d)))
    hidden += site.screened && ok ? 1 : 0
  }
  const pieces = rows.reduce((a, s) => a + s.flank.length, 0)
  check(screened === rows.length && e.rejected.screen === 0, 'every mouth on the flat wood is screened', `${screened}/${rows.length}`)
  check(counted === rows.length, `by ${SCREEN.count} pieces of ${SCREEN.kinds.join(', ')}`, `${counted}/${rows.length}`)
  check(SCREEN.kinds.every((k) => kinds[k] > 0), 'and every kind stands somewhere', JSON.stringify(kinds))
  check(laid === screened, 'the first beside the arch, the second beside it on the other side or before it', `${laid}/${screened}`)
  check(across > 0 && across < screened, 'and each of those at some mouth', `${across} across, ${screened - across} before`)
  check(hidden === screened, 'from 40 m out, a piece before the arch hides it straight on and 20 degrees off, one beside it 70 and 80 degrees off its side', `${hidden}/${screened}`)
  check(climbed === pieces - kinds.pine, 'every stone is stone to the walker at its centre, its hull\'s top within 25 cm of its box\'s', `${climbed}/${pieces - kinds.pine}`)
  check(trees.loosePlanted === kinds.pine, 'and every pine is planted in the trees', `${trees.loosePlanted}/${kinds.pine}`)
  // The walker, not the leafkin's ground: a flood over 0.2 m steps from the
  // mouth point, where her capsule fits on the ground (WalkSurface.fits) and no
  // pine's trunk stands (obstacleAt), reaches a metre past every piece.
  const pines = rows.flatMap((s) => s.flank.filter((f) => f.kind === 'pine'))
  const trunks = {
    trunkAt: (x, z, pad, out) => {
      for (const f of pines) {
        if (Math.hypot(x - f.x, z - f.z) < f.r + pad) { out.x = f.x; out.z = f.z; out.r = f.r + pad; return out }
      }
      return null
    },
  }
  const walk = new WalkSurface(field, rocks, trunks)
  walk.addStone(e)
  const hit = { x: 0, z: 0, r: 0 }
  let walkedOut = 0
  const STEP = 0.2
  for (const site of rows) {
    const reach = site.flankReach + 1
    const c = Math.ceil(reach / STEP) + 1, n = 2 * c + 1
    const seen = new Uint8Array(n * n)
    const open = (i, j) => {
      const x = site.x + (i - c) * STEP, z = site.z + (j - c) * STEP
      return walk.fits(x, z, GROUND) && !walk.obstacleAt(x, z, hit)
    }
    const queue = [c * n + c]
    seen[c * n + c] = 1
    let escaped = false
    while (queue.length && !escaped) {
      const k = queue.pop()
      const i = k % n, j = (k - i) / n
      if (Math.hypot(i - c, j - c) * STEP >= reach) escaped = true
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj
        if (ii < 0 || jj < 0 || ii >= n || jj >= n || seen[jj * n + ii]) continue
        seen[jj * n + ii] = 1
        if (open(ii, jj)) queue.push(jj * n + ii)
      }
    }
    walkedOut += escaped ? 1 : 0
  }
  check(walkedOut === rows.length, 'from every mouth point she walks out past its screen', `${walkedOut}/${rows.length}`)
  // The door: from the mouth point at the face, her feet come within
  // PORTAL.walk of the hole, on the ground the whole way.
  const warn = console.warn
  console.warn = () => {}
  let reached = 0, stayed = 0
  for (const site of rows) {
    const rig = new THREE.Group()
    const camera = new THREE.PerspectiveCamera()
    camera.position.y = LOCOMOTION.eyeHeight
    rig.add(camera)
    const player = new Player(rig, camera, walk)
    player.spawnAt(site.x, site.z)
    camera.rotation.y = Math.atan2(site.nx, site.nz)
    rig.updateMatrixWorld(true)
    let nearest = Infinity, top = -Infinity
    for (let f = 0; f < 72 * 4 && nearest > PORTAL.walk; f++) {
      player.update(1 / 72, { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true })
      rig.updateMatrixWorld(true)
      nearest = Math.min(nearest, Math.hypot(rig.position.x - site.holeX, rig.position.z - site.holeZ))
      top = Math.max(top, rig.position.y)
    }
    reached += nearest <= PORTAL.walk ? 1 : 0
    stayed += top < GROUND + 0.5 ? 1 : 0
  }
  console.warn = warn
  check(reached === rows.length, `at the face, her feet come within PORTAL.walk ${PORTAL.walk} m of the hole`, `${reached}/${rows.length}`)
  check(stayed === rows.length, 'on the ground the whole way', `${stayed}/${rows.length}`)
  // Ground walled in past FINAL_M: a screen has no way out to shut, so every mouth takes one.
  const bareTrees = new Trees(new THREE.Scene(), field, water, texArray, { seed: 7, plantRoom: SCREEN_POOL })
  const shut = new Entrances(new THREE.Scene(), field, water, rocks, { seed: 7, radius: 450, bank: e.bank, ground: { cell: () => STONE }, trees: bareTrees })
  shut.place(-900, -900)
  const penned = shut.sites()
  check(penned.length === rows.length && penned.every((s) => s.screened && s.flank.length === SCREEN.count) && shut.rejected.screen === 0,
    'on ground a walker never gets out of, every mouth is still screened, none refused', `${penned.filter((s) => s.screened).length}/${penned.length}`)
  // The one way out a 1 m corridor straight off the mouth: open bare, shut by a boulder standing in it, so such a layout is rolled again.
  const s0 = penned[0]
  shut.ground = { cell: (x, z) => (Math.abs((x - s0.x) * -s0.nz + (z - s0.z) * s0.nx) < 0.5 && (x - s0.x) * s0.nx + (z - s0.z) * s0.nz > -0.5 ? 0 : STONE) }
  const plug = [{ x: s0.x + s0.nx * 4, z: s0.z + s0.nz * 4, r: 1, hull: 2 }]
  check(shut._pathable(s0, plug, false) && !shut._pathable(s0, plug), 'a piece across the only way out shuts a mouth that was open bare', `bare ${shut._pathable(s0, plug, false)}, screened ${shut._pathable(s0, plug)}`)
  // Released, a site's pines leave the trees.
  for (const site of [...e.resident.values()]) e._release(site)
  check(trees.loosePlanted === 0, 'and a released site unplants its pines', `${trees.loosePlanted} left`)
}

// --- the screens' stones grow what a boulder does -------------------------------
//
// The wood's trees and ferns placed first, as main.js boots them, then the
// mouths: a tree or fern over a screen's stone stands on its surface, and off
// it again once the site is released.
console.log('\nthe screens\' stones grow what a boulder does')
{
  const site0 = boot(-900, -900, { radius: 450 }).e.sites()[0]
  const rocks = new Rocks(new THREE.Scene(), field, water, layers, texArray, { seed: 7 })
  rocks.place(site0.x, site0.z)
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed: 7, rocks, plantRoom: SCREEN_POOL })
  trees.place(site0.x, site0.z)
  const ferns = new Ferns(new THREE.Scene(), field, water, { ...layers, paths: { nearest: () => null } }, texArray, { seed: 7, rocks })
  ferns.place(site0.x, site0.z)
  const e = new Entrances(new THREE.Scene(), field, water, rocks, { seed: 7, radius: 450, bank: mouthBankFrom(readShippedLadder('cave-mouth')), ground: new LeafkinGround({ field, water, rocks }), trees, ferns })
  e.place(site0.x, site0.z)
  // Every resident of `layer` standing over a screen's stone where no rock of the wood's is higher: [id, stone top].
  const over = (layer, ids) => ids.flatMap((id) => {
    const x = layer.instX[id], z = layer.instZ[id], top = e.blockTopAt(x, z)
    return top > GROUND + 0.05 && top > rocks.blockTopAt(x, z, 0) ? [[id, top]] : []
  })
  const idsOf = (layer) => [...layer.tiles.values()].flatMap((t) => [...t.ids.subarray(0, t.n)])
  // A tree's base is its y plus its sink; a fern's is its y.
  const base = (layer, id) => layer.instY[id] + (layer === trees ? trees.instSink[id] : 0)
  const onTrees = over(trees, idsOf(trees))
  const lifted = onTrees.filter(([id, top]) => base(trees, id) >= top - 1e-3).length
  check(onTrees.length > 0 && lifted === onTrees.length, 'every tree over a screen\'s stone stands on its surface', `${lifted}/${onTrees.length}`)
  const onFerns = over(ferns, idsOf(ferns))
  const seated = onFerns.filter(([id, top]) => base(ferns, id) >= top - 1e-3).length
  check(onFerns.length > 0 && seated === onFerns.length, 'every fern over a screen\'s stone is seated on it', `${seated}/${onFerns.length}`)
  // Evicted as place() evicts: out of the resident map, then released.
  for (const [key, site] of [...e.resident]) {
    e.resident.delete(key)
    e._release(site)
  }
  const up = (layer) => idsOf(layer).filter((id) => base(layer, id) > Math.max(GROUND, rocks.blockTopAt(layer.instX[id], layer.instZ[id], 0)) + 1e-3).length
  check(up(trees) === 0 && up(ferns) === 0, 'released, each stands on the ground or the wood\'s own rock again', `${up(trees)} trees, ${up(ferns)} ferns still up`)
}

// --- two boots agree ----------------------------------------------------------
console.log('\ntwo boots agree')
{
  const a = boot(0, 0).e.sites().sort((p, q) => (p.key < q.key ? -1 : 1))
  const b = boot(0, 0).e.sites().sort((p, q) => (p.key < q.key ? -1 : 1))
  const same = a.length === b.length && a.every((s, i) => {
    const t = b[i]
    return s.key === t.key && s.x === t.x && s.y === t.y && s.z === t.z && s.nx === t.nx && s.nz === t.nz && s.r === t.r
  })
  check(same && a.length > 0, 'a second boot seats every mouth on the same point and normal to the bit', `${a.length} sites`)
  const other = boot(0, 0, { seed: 11 }).e.sites()
  const keys = new Set(a.map((s) => s.key))
  const moved = other.filter((s) => keys.has(s.key)).some((s) => a.find((t) => t.key === s.key).nx !== s.nx)
  check(moved || other.every((s) => !keys.has(s.key)), 'and another seed rolls another bearing', `${other.length} sites on seed 11`)
}

// --- the record survives eviction -------------------------------------------
//
// The leafkin's cooldown lives on the site's `state`; the layer keeps it in
// `memory` past the tile going, so a village she scared empty stays empty
// when she walks back an hour later.
console.log('\nthe record survives eviction')
{
  const { e } = boot(0, 0, { radius: 600 })
  const first = e.sites()[0]
  check(!!first, 'a site is resident at the origin', `${e.stats.placed} placed`)
  if (first) {
    first.state.fledAt = 1234
    const far = { x: first.x + 3000, z: first.z + 3000 }
    e.rocks.place(far.x, far.z)
    e.update(far.x, GROUND, far.z)
    check(!e.sites().some((s) => s.key === first.key), 'the site goes when the camera leaves', `${e.stats.placed} resident`)
    check(e.stats.used === e.stats.placed, 'and its instance returns to the pool', `${e.stats.used} used`)
    e.rocks.place(0, 0)
    e.update(0, GROUND, 0)
    const back = e.sites().find((s) => s.key === first.key)
    check(!!back && back.state.fledAt === 1234, 'and comes back with its record', back ? `fledAt ${back.state.fledAt}` : 'not back')
    check(!!back && back.id >= 0 && back !== first, 'on a fresh site object', '')
  }
}

// --- the ladder -----------------------------------------------------------------
console.log('\nthe ladder')
{
  const { e } = boot(0, 0, { radius: 600 })
  const site = e.sites()[0]
  const reach = (k) => propReach(MOUTH_HEIGHT_M, k)
  const tiersAt = []
  for (const d of [reach(0) * 0.5, reach(0) * 1.5, reach(1) * 1.5, reach(2) * 1.5]) {
    e.update(site.ax + site.nx * d, site.ay, site.az + site.nz * d)
    tiersAt.push(e.tierAt[site.id])
  }
  check(tiersAt.join(' ') === '0 1 2 3', 'an arch steps down its three tiers and out past the props\' cull', `tiers ${tiersAt.join(' ')} at rungs ${PROP_STEPS.join('/')}`)
  const hidden = tiersAt[3] === RUNGS && !e.batch.getVisibleAt(site.id)
  check(hidden, 'culled, the arch is hidden', '')
  e.update(site.ax + site.nx * reach(0) * 0.5, site.ay, site.az + site.nz * reach(0) * 0.5)
  check(e.batch.getVisibleAt(site.id) && e.tris > 0, 'and back in, drawn', `${e.tris} tris`)
  check(e.stats.cull > 100, 'the props\' cull for a 1.5 m arch is past a hundred metres', `${e.stats.cull.toFixed(0)} m`)
  // A screen's stone is on the rocks' ladder, not the arch's: a rock of size s
  // is T0 within ROCK_LOD_AT[0] * s and stands when the arch is culled.
  const stoned = e.sites().find((s) => s.flank.some((f) => f.kind === 'boulder'))
  const stone = stoned.flank.find((f) => f.kind === 'boulder')
  const stoneTiers = []
  for (const k of [0.5, 1.5, 4, 9]) {
    const d = ROCK_LOD_AT[0] * stone.size * k
    e.update(stone.x + stoned.nx * d, 0.5 * (stone.y + stone.top), stone.z + stoned.nz * d)
    stoneTiers.push(`${e.stones.tier[stone.id]}${e.flank.getVisibleAt(stone.id) ? '' : 'hidden'}`)
  }
  check(stoneTiers.join(' ') === '0 1 2 3', `a ${stone.size.toFixed(1)} m stone steps down the rocks' four tiers at ROCK_LOD_AT, standing past the arch's cull`, `tiers ${stoneTiers.join(' ')} at ${ROCK_LOD_AT.join('/')} m per metre`)
  check(RADIUS_M >= 200, 'a site is resident past the leafkin\'s roam', `${RADIUS_M} m`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall entrances checks passed')
process.exit(failures ? 1 : 0)
