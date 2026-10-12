// Gates for the palisade labyrinths (src/v2/layers/labyrinths.js, render/palisades.js; DESIGN.md §41), on the shipped world.
//
//   node scripts/check-labyrinths.mjs [every=1]
//
// Pure, every labyrinth: the cells are one maze -- every cell reached from the one entrance, one door to the middle --
// and every point of wall line stands under a post's face or in a crack no wider than CRACK.width. Walked, every `every`th labyrinth: flooded on a
// quarter-metre grid by WalkSurface's own heightAt and fits against Palisades' columnAt, every cell is reached from
// outside, and with the gate plugged none is. Climbed, on the first labyrinth's towers: the desktop's walk up a ladder onto its deck
// and back down unhurt, a hold that keeps her height until she walks, and a walk off the held ladder priced as a fall.

import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { CRACK, POST_FACE, POST_GIRTH, POST_HEIGHT, POST_R, POST_STRIDE, TOWER } from '../src/v2/layers/labyrinths.js'
import { Palisades } from '../src/v2/render/palisades.js'
import { WalkSurface } from '../src/v2/walk.js'
import { LOCOMOTION, Player } from '../src/player.js'
import { Climb } from '../src/v2/climb.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'

const EVERY = Number(process.argv[2] ?? 1)
const MIN_LABYRINTHS = 80
// A corridor leaves the walker's centre a band about 0.75 m across; a 0.5 m grid cannot step diagonally through it.
const GRID = 0.25

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const hm = await Heightmap.read({ path: new URL('../public/world/height.png', import.meta.url), metaPath: new URL('../public/world/height.json', import.meta.url) })
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
field.setLayers(layers)
new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field }).rebuild()
const labyrinths = new BiomeField({ seed: SEED, ground: field }).labyrinths

const sites = labyrinths.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF).slice()
check(sites.length >= MIN_LABYRINTHS, `the world holds at least ${MIN_LABYRINTHS} labyrinths`, `${sites.length}`)

console.log('\nthe maze and its posts')
let worstGap = 0
const girths = [Infinity, -Infinity]
let towerCount = 0
// Half the widest crack, and 2 mm for the line bending between two posts.
const HALF_CRACK = CRACK.width[1] / 2 + 0.002
for (const s of sites) {
  const m = labyrinths.mazeOf(s)
  const { sectors, offs, wallCw, wallIn, wallOut } = m
  const rings = sectors.length
  const label = `labyrinth at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)})`
  // Through open walls only, from the entrance cell.
  const seen = new Uint8Array(offs[rings])
  const queue = [offs[rings - 1] + m.entrance]
  seen[queue[0]] = 1
  const go = (k, j) => { const id = offs[k] + j; if (!seen[id]) { seen[id] = 1; queue.push(id) } }
  for (let q = 0; q < queue.length; q++) {
    let k = 0
    while (queue[q] >= offs[k + 1]) k++
    const j = queue[q] - offs[k], n = sectors[k]
    if (!wallCw[k][j]) go(k, (j + 1) % n)
    if (!wallCw[k][(j - 1 + n) % n]) go(k, (j - 1 + n) % n)
    if (k > 0 && !wallIn[k][j]) go(k - 1, Math.floor((j * sectors[k - 1]) / n))
    if (k + 1 < rings) {
      const f = sectors[k + 1] / n
      for (let i = 0; i < f; i++) if (!wallIn[k + 1][j * f + i]) go(k + 1, j * f + i)
    }
  }
  const reached = seen.reduce((a, b) => a + b, 0)
  const ways = wallOut.length - wallOut.reduce((a, b) => a + b, 0)
  const doors = wallIn[0].length - wallIn[0].reduce((a, b) => a + b, 0)
  check(reached === offs[rings] && ways === 1 && doors === 1 && m.torches.length === 2,
    `${label}: every cell reached from the one entrance, one door to the middle, two torches`,
    `${reached}/${offs[rings]} reached, ${ways} ways in, ${doors} doors, ${m.torches.length} torches`)

  // The towers: at least TOWER.least, each post clear of every wall (a centimetre's kiss allowed).
  let clash = 0
  for (const t of m.towers) for (const [x, z] of t.corners) if (labyrinths.wallAt(x, z, POST_R * TOWER.girth - 0.01)) clash++
  towerCount += m.towers.length
  if (m.towers.length < TOWER.least || clash > 0) check(false, `${label}: at least ${TOWER.least} towers, their posts clear of the walls`, `${m.towers.length} towers, ${clash} posts in a wall`)

  // Every point of every wall line under a post's face (its mean radius at its girth) or in a crack at most CRACK.width wide, and no line's girths scaled far past POST_GIRTH to land it.
  const posts = labyrinths.postsOf(s)
  const H = 1, grid = new Map()
  for (let i = 0; i < posts.length; i += POST_STRIDE) {
    const key = Math.floor(posts[i] / H) * 65536 + Math.floor(posts[i + 1] / H)
    if (!grid.has(key)) grid.set(key, [])
    const girth = posts[i + 6]
    grid.get(key).push(posts[i], posts[i + 1], POST_R * POST_FACE * girth)
    girths[0] = Math.min(girths[0], girth)
    girths[1] = Math.max(girths[1], girth)
  }
  const nearest = (x, z) => {
    let best = Infinity
    const gx = Math.floor(x / H), gz = Math.floor(z / H)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get((gx + dx) * 65536 + gz + dz)
      if (list) for (let q = 0; q < list.length; q += 3) best = Math.min(best, Math.hypot(list[q] - x, list[q + 1] - z) - list[q + 2])
    }
    return best
  }
  let gap = 0
  const seg = m.segments
  for (let k = 0; k < seg.length; k += 4) {
    const L = Math.hypot(seg[k + 2] - seg[k], seg[k + 3] - seg[k + 1])
    for (let t = 0; t <= L; t += 0.05) gap = Math.max(gap, nearest(seg[k] + ((seg[k + 2] - seg[k]) * t) / L, seg[k + 1] + ((seg[k + 3] - seg[k + 1]) * t) / L))
  }
  worstGap = Math.max(worstGap, gap)
  if (gap > HALF_CRACK) check(false, `${label}: every point of wall under a post or a crack`, `${(gap * 2).toFixed(3)} m crack`)
}
check(worstGap <= HALF_CRACK, `every labyrinth: every point of wall under a post or a crack at most ${CRACK.width[1]} m`, `widest ${(worstGap * 2).toFixed(3)} m`)
check(true, 'every labyrinth: its towers', `${towerCount} in all`)
check(girths[0] > POST_GIRTH[0] * 0.7 && girths[1] < POST_GIRTH[1] * 1.3, 'every labyrinth: girths within 30% of POST_GIRTH (a metre-long line scales by up to a quarter)', `${girths[0].toFixed(2)}-${girths[1].toFixed(2)}`)

// The drums' reach (ambience.js RULES.drums): along every eighth of a turn, heard just inside the reach and not just past it, rising toward the middle, and the middle only within it.
{
  const R = 20, out = {}
  let bad = 0
  for (const s of sites) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, ux = Math.cos(a), uz = Math.sin(a)
      let edge = 1
      while (labyrinths.insideAt(s.cx + ux * edge, s.cz + uz * edge)) edge += 0.05
      const at = (d) => labyrinths.nearness(s.cx + ux * d, s.cz + uz * d, R, out) ? { ...out } : null
      const inReach = at(edge + R - 0.2), past = at(edge + R + 0.2), wall = at(edge - 0.2), mid = at(0.5), ring0 = at(3)
      if (!inReach || past || inReach.near > 0.02 || inReach.middle || !wall || wall.near <= inReach.near || wall.middle || !mid || !mid.middle || mid.near !== 1 || ring0.middle || inReach.s !== s) bad++
    }
  }
  check(bad === 0, 'every labyrinth: its drums heard to 20 m past its outline, rising toward the middle, which is only its middle', `${bad} bearings wrong`)
}

// The giant's graph (mazeOf `ways`): one piece from the middle, every node found where it is by nodeAt, and every leg -- a node, the opening, the next node -- WAY_PAD clear of the walls.
{
  const WAY_PAD = 0.25
  let split = 0, lost = 0, legs = 0, grazed = 0
  for (const s of sites) {
    const m = labyrinths.mazeOf(s), total = m.cells.length
    const at = (id) => (id === total ? m.middle : m.cells[id])
    const seen = new Uint8Array(total + 1), queue = [total]
    seen[total] = 1
    for (let q = 0; q < queue.length; q++) for (const w of m.ways[queue[q]]) if (!seen[w.to]) { seen[w.to] = 1; queue.push(w.to) }
    if (queue.length !== total + 1) split++
    for (let id = 0; id <= total; id++) {
      if (labyrinths.nodeAt(s, ...at(id)) !== id) lost++
      for (const w of m.ways[id]) {
        legs++
        const pts = [at(id), [w.x, w.z], at(w.to)]
        let hit = false
        for (let p = 0; p < 2 && !hit; p++) {
          const [ax, az] = pts[p], [bx, bz] = pts[p + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1)
          for (let i = 0; i <= n && !hit; i++) hit = labyrinths.wallAt(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, WAY_PAD)
        }
        if (hit) grazed++
      }
    }
  }
  check(split === 0, 'every labyrinth: the giant\'s graph is one piece, the middle to every cell', `${split} split`)
  check(lost === 0, 'every labyrinth: nodeAt finds every cell\'s and the middle\'s node where it is', `${lost} lost`)
  check(grazed === 0, `every labyrinth: every leg of the graph ${WAY_PAD} m clear of the walls`, `${grazed}/${legs} grazed`)
}

console.log('\nthe walker in the walls')
// Palisades' stone answers off the labyrinths and the field alone, so the gate walks the shipped columnAt without the meshes.
const palisades = Object.assign(Object.create(Palisades.prototype), { labyrinths, field })
let plug = null
const plugStone = {
  columnAt: (x, z, _min, out) => {
    if (plug === null) return 0
    const [ax, az, bx, bz] = plug, dx = bx - ax, dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 >= POST_R * POST_R) return 0
    out[0] = -Infinity
    out[1] = Infinity
    return 1
  },
  blockTopAt: () => -Infinity,
}
const walk = new WalkSurface(field, { columnAt: () => 0, blockTopAt: () => -Infinity }, { trunkAt: () => false })
walk.addStone(palisades)
walk.addStone(plugStone)

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// A flood over [x0, x1] x [z0, z1] from `starts` on the grid, by the walker's step: her foot height carried, the next
// tread whatever heightAt finds within her reach, climbed only as Player._walkable allows, and only where she fits.
const MAX_TAN = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180)
const climbs = (x, z, h0, dx, dz, h1) => (h1 - h0) / GRID <= MAX_TAN ||
  (walk.heightAt(x + dx * LOCOMOTION.stride, z + dz * LOCOMOTION.stride, h0) - h0) / LOCOMOTION.stride <= MAX_TAN
function flood(x0, z0, x1, z1, starts) {
  const w = Math.round((x1 - x0) / GRID) + 1, h = Math.round((z1 - z0) / GRID) + 1
  const y = new Float64Array(w * h).fill(NaN)
  const queue = []
  for (const [sx, sz] of starts) {
    const i = Math.round((sx - x0) / GRID), j = Math.round((sz - z0) / GRID)
    const x = x0 + i * GRID, z = z0 + j * GRID
    const foot = walk.heightAt(x, z)
    if (!Number.isNaN(y[j * w + i]) || !walk.fits(x, z, foot)) continue
    y[j * w + i] = foot
    queue.push(j * w + i)
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q], i = k % w, j = (k / w) | 0
    for (const [di, dj] of STEPS) {
      const a = i + di, b = j + dj
      if (a < 0 || b < 0 || a >= w || b >= h || !Number.isNaN(y[b * w + a])) continue
      const x = x0 + a * GRID, z = z0 + b * GRID
      const foot = walk.heightAt(x, z, y[k])
      if (!climbs(x0 + i * GRID, z0 + j * GRID, y[k], di, dj, foot) || !walk.fits(x, z, foot)) continue
      y[b * w + a] = foot
      queue.push(b * w + a)
    }
  }
  // A cell centre counts as reached when the grid node nearest it, or one beside it, is: a centre can fall within a capsule of a wall's end.
  return {
    at: (x, z) => {
      const i = Math.round((x - x0) / GRID), j = Math.round((z - z0) / GRID)
      for (const [di, dj] of [[0, 0], ...STEPS]) if (!Number.isNaN(y[(j + dj) * w + i + di])) return true
      return false
    },
  }
}

for (let si = 0; si < sites.length; si += EVERY) {
  const s = sites[si]
  const m = labyrinths.mazeOf(s)
  const label = `labyrinth at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)})`
  const pad = s.reach + 2
  const bx0 = s.cx - pad, bz0 = s.cz - pad, bx1 = s.cx + pad, bz1 = s.cz + pad
  const ring = []
  for (let t = 0; t <= 2 * pad; t += GRID) ring.push([bx0 + t, bz0], [bx0 + t, bz1], [bx0, bz0 + t], [bx1, bz0 + t])
  // A tower's cell counts at its ladder's foot, the middle at the altar's front: the tower and the plinth stand on their centres.
  const towerAt = new Map(m.towers.map((t) => [t.cell, [t.x + t.ux * TOWER.foot, t.z + t.uz * TOWER.foot]]))
  const marks = m.cells.map((c, id) => towerAt.get(id) ?? c)
  marks.push([m.altar.x + m.altar.ux * 0.9, m.altar.z + m.altar.uz * 0.9])
  const missedFrom = () => {
    const f = flood(bx0, bz0, bx1, bz1, ring)
    return marks.map((p, id) => id).filter((id) => !f.at(...marks[id]))
  }
  const nameOf = (id) => id === m.cells.length ? 'the altar' : towerAt.has(id) ? `tower ${id}'s ladder` : `cell ${id}`
  plug = null
  const missed = missedFrom()
  check(missed.length === 0, `${label}: the walker reaches every cell, every ladder's foot and the altar from outside`, missed.length ? `missed ${missed.map(nameOf).join(', ')}` : `${marks.length} marks`)
  // The outer wall is lines[0], one arc from the gate's far post round to its near one: plug the chord between its ends.
  const outer = m.lines[0].xz
  plug = [outer[0], outer[1], outer[outer.length - 2], outer[outer.length - 1]]
  const shut = marks.length - missedFrom().length
  plug = null
  check(shut === 0, `${label}: and with the gate plugged, none`, `${shut} reached`)
}

console.log('\nthe climber on the towers')
{
  const DT = 1 / 60
  const rig = new THREE.Group(), camera = new THREE.PerspectiveCamera()
  rig.add(camera)
  camera.position.y = 1.6
  const player = new Player(rig, camera, walk)
  const climb = new Climb(player, palisades)
  const still = () => ({ move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true })
  // Faces her along (fx, fz) and walks `move` for up to `secs`, the climb first as main.js runs it; the worst fall on the way.
  const walkFor = (fx, fz, move, secs, until = () => false) => {
    rig.rotation.set(0, Math.atan2(-fx, -fz), 0)
    rig.updateMatrixWorld(true)
    let fell = 0
    for (let t = 0; t < secs && !until(); t += DT) {
      const input = { ...still(), move }
      climb.desk(DT, input, fx, fz)
      player.update(DT, input)
      rig.updateMatrixWorld(true)
      fell = Math.max(fell, player.fell)
    }
    return fell
  }
  const m = labyrinths.mazeOf(sites[0])
  let ups = 0, downs = 0, holds = 0, drops = 0, pulls = 0
  for (const t of m.towers) {
    const deck = field.heightAt(t.x, t.z) + TOWER.deck
    const fx = t.x + t.ux * TOWER.foot, fz = t.z + t.uz * TOWER.foot
    player.teleportTo(fx + t.ux * 0.3, fz + t.uz * 0.3)
    const upFell = walkFor(-t.ux, -t.uz, 1, 15, () => !player.held && Math.abs(player.standY - deck) < 0.05)
    if (upFell === 0 && Math.abs(player.standY - deck) < 0.05 && Math.hypot(rig.position.x - t.x, rig.position.z - t.z) < 0.3) ups++
    const downFell = walkFor(t.ux, t.uz, 1, 15, () => !player.held && player.standY < deck - 1)
    if (downFell === 0 && Math.abs(player.standY - field.heightAt(fx, fz)) < 0.1) downs++
    // Held halfway up, a still second keeps her there; walking back off the ladder is a fall from there.
    player.teleportTo(fx, fz)
    player.hold(field.heightAt(fx, fz) + 4)
    const heldY = rig.position.y
    for (let t2 = 0; t2 < 1; t2 += DT) player.update(DT, still())
    if (rig.position.y === heldY && player.held) holds++
    if (walkFor(-t.ux, -t.uz, -1, 4) > 3.5) drops++
    // A headset hand grips a rung at chest height and draws down 0.8 m: she rises 0.8 m and stays when it lets go.
    player.teleportTo(fx, fz)
    const y0 = rig.position.y, hand = new THREE.Vector3(t.x + t.ux * TOWER.ladderOut, 0, t.z + t.uz * TOWER.ladderOut)
    for (let i = 0; i <= 40; i++) {
      hand.y = rig.position.y + 1.2 - (0.8 * i) / 40
      climb.grip('right', true, i === 0, true, hand)
    }
    climb.grip('right', false, false, true, hand)
    for (let t2 = 0; t2 < 1; t2 += DT) player.update(DT, still())
    if (Math.abs(rig.position.y - y0 - 0.8) < 0.02 && player.held) pulls++
  }
  const n = m.towers.length
  const across = { x: 0, z: 0 }, [wx, wz] = m.lines[0].xz, wy = field.heightAt(wx, wz) + POST_HEIGHT
  check(palisades.onWallTop(wx, wz, wy, across) && Math.abs(Math.hypot(across.x, across.z) - 1) < 1e-6 && !palisades.onWallTop(wx, wz, wy - 1, across) && !palisades.onWallTop(wx + 1, wz, wy, across),
    'feet at a wall\'s top are on its points, with the unit across it; a metre lower or a metre off, not')
  check(ups === n, 'every tower: walked up its ladder onto its deck, unhurt', `${ups}/${n}`)
  check(downs === n, 'and walked off its deck down the ladder to its foot, unhurt', `${downs}/${n}`)
  check(pulls === n, 'a gripped rung drawn down 0.8 m lifts her 0.8 m, held when the hand lets go', `${pulls}/${n}`)
  check(holds === n && drops === n, 'held 4 m up, she stays; walking back off the ladder is a fall from there', `${holds}/${n} held, ${drops}/${n} fell`)
}

console.log(failures === 0 ? '\nall labyrinth checks passed' : `\n${failures} labyrinth check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
