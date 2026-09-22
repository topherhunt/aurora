// Node-side gates for the boats she can board (src/v2/boats.js) and the hull
// section the rowboat bank carries for them (src/v2/render/rowboats.js).
//
//   node scripts/check-boats.mjs
//
// What can go wrong without throwing: a waterline slice that finds one skin
// or an open loop, so the lid leaks; a floor over the gunwale; a bow at the
// stern, so weight forward rows her backwards; a boat that keeps its seat in
// the scatter while it is live, so two are drawn; a mooring lost to a tile
// eviction; a hull that is not stone; a rider not carried; a sample that
// lands as a step; a drive that never stops; a river that does not carry the
// boat, or carries it through the bank; and a lake's edge that stops it.

import * as THREE from 'three'
import { DRAFT, Rowboats, inLoop, loopArea, rowboatsBankFrom, sliceLoops, soleAt } from '../src/v2/render/rowboats.js'
import { Boats, MAX_LIVE } from '../src/v2/boats.js'
import { GEN_PROPS_DIR, readShippedAsset } from './lib/gen-prop-node.mjs'
import path from 'node:path'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const shippedBank = () => rowboatsBankFrom(readShippedAsset(path.join(GEN_PROPS_DIR, 'rowboat-viking.glb')))

/** A straight coast falling from x = 0 into a lake at `level` (check-rowboats.mjs). */
const coast = (level, tan) => ({
  field: {
    heightAt: (x) => level - x * tan,
    heightAndSlopeAt: (x) => ({ h: level - x * tan, tan }),
  },
  water: {
    levelAt: () => level,
    lakeLevelAt: () => level,
    flowAt: () => 0,
    lakeShoreDistAt: (x, z, reach, g, t) => {
      const d = (g - level) / Math.max(t, 0.01)
      return d < -reach ? -reach : d > reach ? reach : d
    },
  },
})
const LEVEL = 40
const world = coast(LEVEL, 1.0)
/** The coast with a river down it: the lake's footprint ends at z = 50 and the level runs on as a river's, and a current of `dir` at full weight wherever `where(x, z)`. */
const riverCoast = (level, tan, where, dir) => {
  const w = coast(level, tan)
  w.water.lakeLevelAt = (x, z) => (z > 50 ? null : level)
  w.water.flowAt = (x, z, out) => {
    if (!where(x, z)) return 0
    out.x = dir[0]
    out.z = dir[1]
    return 1
  }
  return w
}

const fakePlayer = () => {
  const rig = new THREE.Object3D()
  return {
    rig,
    originPosition: (out) => out.copy(rig.position),
    headPosition: (out) => out.copy(rig.position).setY(rig.position.y + 1.6),
  }
}
const fakeNet = (id) => ({ id, peers: new Map(), boats: null, boatsSerial: 0 })

/** The walk loop's edge abeam of the centre: the furthest x on the centre's row still inside it. */
const railAt = (walk, cx, cz) => {
  let x = cx
  while (inLoop(walk, x + 0.002, cz)) x += 0.002
  return x
}

const firstBoat = (r) => {
  for (const tile of r.tiles.values()) if (tile.n) return tile.boats[0]
  throw new Error('no boat placed')
}

// --- the section ------------------------------------------------------------
{
  console.log('\nthe bank carries the hull\'s section at the waterline')
  const bank = shippedBank()
  const h = bank.hull
  const geo = bank.tiers[0].geometries[0]
  const loops = sliceLoops(geo, h.waterline).filter((l) => inLoop(l, h.cx, h.cz))
  check(loops.length >= 2, 'the waterline cuts the hull into an outside and an inside round its centre', `${loops.length} loops`)
  const [rail, deck] = loops
  check(Math.abs(loopArea(deck)) < Math.abs(loopArea(rail)) && Math.abs(loopArea(deck)) > 0.25 * Math.abs(loopArea(rail)),
    'the inner skin lies inside the outer and is most of its area', `${Math.abs(loopArea(deck)).toFixed(3)} in ${Math.abs(loopArea(rail)).toFixed(3)}`)
  let deckInRail = true
  for (const [x, z] of deck) if (!inLoop(rail, x, z)) deckInRail = false
  check(deckInRail, 'every point of the inner skin is inside the outer')
  check(h.floorY > h.keelY && h.floorY < h.waterline && h.gunwaleY > h.waterline,
    'the floor is between keel and waterline, the gunwale over it',
    `keel ${h.keelY.toFixed(3)}, floor ${h.floorY.toFixed(3)}, waterline ${h.waterline.toFixed(3)}, gunwale ${h.gunwaleY.toFixed(3)}`)
  check(h.bow === -1 || h.bow === 1, 'the bow is one end', `bow at z ${h.bow > 0 ? '+' : '-'}`)
  // The figurehead: the highest vertex lies on the bow's side of the centre.
  const pos = geo.attributes.position.array
  let top = -Infinity
  let topZ = 0
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > top) { top = pos[i + 1]; topZ = pos[i + 2] }
  check(Math.sign(topZ - h.cz) === h.bow, 'and it is the end the figurehead rises from')

  // The lid is watertight: every edge of the prism is shared by exactly two triangles.
  const lid = h.lid
  const idx = lid.index.array
  const edges = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e]
      const b = idx[t + ((e + 1) % 3)]
      const k = a < b ? `${a}-${b}` : `${b}-${a}`
      edges.set(k, (edges.get(k) || 0) + 1)
    }
  }
  let open = 0
  for (const n of edges.values()) if (n !== 2) open++
  check(open === 0, 'the lid is a closed prism', `${idx.length / 3} triangles, ${edges.size} edges, ${open} open`)
  const lp = lid.attributes.position.array
  let lo = Infinity
  let hi = -Infinity
  for (let i = 1; i < lp.length; i += 3) { lo = Math.min(lo, lp[i]); hi = Math.max(hi, lp[i]) }
  check(lo < h.waterline && hi > h.waterline && hi < h.gunwaleY, 'the lid straddles the waterline under the gunwale', `${lo.toFixed(3)}..${hi.toFixed(3)}`)
  // Its plan reaches past the bilge's flat to where the floor climbs clear of its top.
  let lidZ0 = Infinity
  let lidZ1 = -Infinity
  let deckZ0 = Infinity
  let deckZ1 = -Infinity
  for (let i = 0; i < lp.length; i += 3) { lidZ0 = Math.min(lidZ0, lp[i + 2]); lidZ1 = Math.max(lidZ1, lp[i + 2]) }
  for (const [, z] of deck) { deckZ0 = Math.min(deckZ0, z); deckZ1 = Math.max(deckZ1, z) }
  const soleAtLidEnd = Math.min(soleAt(h.sole, h.cx, lidZ0), soleAt(h.sole, h.cx, lidZ1))
  check(lidZ0 < deckZ0 && lidZ1 > deckZ1 && soleAtLidEnd > hi - 0.01, 'and its plan reaches past the bilge to where the floor is over its top',
    `lid ${lidZ0.toFixed(3)}..${lidZ1.toFixed(3)}, bilge ${deckZ0.toFixed(3)}..${deckZ1.toFixed(3)}, floor at the ends ${soleAtLidEnd.toFixed(3)} against ${hi.toFixed(3)}`)

  // The sole: the boards amidships, higher toward the bow, the gunwale past the walk loop.
  let walkInPad = true
  for (const [x, z] of h.walk) if (!inLoop(h.pad, x, z)) walkInPad = false
  check(walkInPad && Math.abs(loopArea(h.walk)) > Math.abs(loopArea(deck)), 'the walk loop is wider than the bilge and inside the pad',
    `walk ${Math.abs(loopArea(h.walk)).toFixed(3)}, bilge ${Math.abs(loopArea(deck)).toFixed(3)}, pad ${Math.abs(loopArea(h.pad)).toFixed(3)}`)
  const mid = soleAt(h.sole, h.cx, h.cz)
  let bowZ = h.cz
  for (const [, z] of h.walk) if ((z - h.cz) * h.bow > (bowZ - h.cz) * h.bow) bowZ = z
  const bowSole = soleAt(h.sole, h.cx, h.cz + (bowZ - h.cz) * 0.85)
  const railX = railAt(h.walk, h.cx, h.cz)
  const overRail = soleAt(h.sole, h.cx + (railX - h.cx) * 1.04, h.cz)
  check(Math.abs(mid - h.floorY) < 0.01 && bowSole > mid + 0.03 && Math.abs(overRail - h.gunwaleY) < 0.01,
    'the sole is the floor amidships, climbs to the bow and is the gunwale over the rail',
    `mid ${mid.toFixed(3)}, bow ${bowSole.toFixed(3)}, rail ${overRail.toFixed(3)}`)
}

// --- live and moored --------------------------------------------------------
{
  console.log('\na boat taken live leaves the scatter and moors back where it is left')
  const r = new Rowboats(new THREE.Scene(), world.field, world.water, { seed: 11, radius: 1200, bank: shippedBank() })
  r.place(0, 0)
  const b = firstBoat(r)
  const placed = r.placed
  const origin = b.origin
  r.setLive(b)
  check(b.live && b.id === -1 && r.placed === placed - 1 && r.seated.has(origin) === false && r.taken.get(origin) === b,
    'live: no seat, no instance, taken by origin', `${r.placed} of ${placed} placed`)
  check(r.near(b.x, b.z, 1).includes(b), 'and near() still finds it')
  // Rowed 3 km along the coast, then moored there.
  const mx = b.x
  const mz = b.z + 3000
  r.moor(b, mx, LEVEL - DRAFT * b.length, mz, 1.234)
  check(!b.live && b.id === -1 && b.z === mz, 'moored out of range: a record, no instance', `at z ${mz}`)
  r.update(mx, LEVEL + 1.6, mz)
  check(b.id >= 0 && r.byOrigin(origin) === b && Math.abs(r.instZ[b.id] - mz) < 1e-3 && Math.abs(r.instX[b.id] - mx) < 1e-3,
    'walking to the mooring draws it there', `instance ${b.id}`)
  const tileOfOrigin = r.tiles.get(origin)
  check(tileOfOrigin === undefined || tileOfOrigin.n === 0, 'its tile of origin holds no boat')
  r.update(0, LEVEL + 1.6, 0)
  check(b.id === -1 && r.byOrigin(origin) === b, 'walking away evicts the mooring\'s tile but keeps the record', `${r.placed} placed`)
  const home = r.tiles.get(origin)
  check(home !== undefined && home.n === 0, 'and the tile it was rolled in stays empty', `taken ${r.taken.size}`)
  r.update(mx, LEVEL + 1.6, mz)
  check(b.id >= 0 && Math.abs(r.instZ[b.id] - mz) < 1e-3, 'and walking back finds it moored where it was left')
  r.dispose()
}

// --- the drive --------------------------------------------------------------
{
  console.log('\nweight forward rows, weight to a side turns, no weight glides to a stop')
  const r = new Rowboats(new THREE.Scene(), world.field, world.water, { seed: 11, radius: 1200, bank: shippedBank() })
  r.place(0, 0)
  const scene = new THREE.Scene()
  const player = fakePlayer()
  const net = fakeNet('a')
  const boats = new Boats(scene, r, world.water, player, net)
  const b = firstBoat(r)
  const hull = r.bank.hull
  const s = b.length / r.long
  // Her feet on the floor, (u, v) from the hull's centre in the pick's units, v toward the bow.
  // Placed as the mover would, between the carry and the settle, then carried.
  let step = null
  const at = (u, v) => {
    step = () => {
      const c = Math.cos(b.yaw)
      const sn = Math.sin(b.yaw)
      const lx = (hull.cx + u) * s
      const lz = (hull.cz + v * hull.bow) * s
      player.rig.position.set(b.x + lx * c + lz * sn, b.y + (hull.floorY - hull.keelY) * s, b.z - lx * sn + lz * c)
    }
  }
  at(0, 0)
  let now = 0
  const tick = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      now += dt * 1000
      boats.update(dt, now)
      if (step) { step(); step = null }
      boats.settle()
    }
  }
  // She starts on the floor, so the boat is within reach of the first live refresh.
  step()
  tick(1)
  check(boats.live.length === 1 && boats.live[0] === b && b.live, 'the boat under her is live', `${boats.live.length} live`)
  check(boats.aboard && boats.authorityOf === b, 'she is aboard and its authority')
  const x0 = b.x
  const z0 = b.z
  tick(120)
  check(Math.hypot(b.x - x0, b.z - z0) < 0.05 && Math.abs(b.v) < 0.01, 'amidships, it stays put', `${Math.hypot(b.x - x0, b.z - z0).toFixed(3)} m in 2 s`)

  // To the bow: she is carried, and the way gathers toward V_MAX along the heading.
  at(0, 0.3 * r.long)
  const yaw0 = b.yaw
  tick(600)
  const fx = Math.sin(yaw0) * hull.bow
  const fz = Math.cos(yaw0) * hull.bow
  const along = (b.x - x0) * fx + (b.z - z0) * fz
  const across = Math.abs(-(b.x - x0) * fz + (b.z - z0) * fx)
  check(b.v > 2.0 && b.v <= 2.4 + 1e-6, 'weight at the bow gathers way over ten seconds', `${b.v.toFixed(2)} m/s`)
  check(along > 10 && across < 0.5 && Math.abs(b.yaw - yaw0) < 0.01, 'ahead, along the heading', `${along.toFixed(1)} m ahead, ${across.toFixed(2)} across`)
  const feet = player.rig.position
  const c = Math.cos(b.ryaw)
  const sn = Math.sin(b.ryaw)
  const lu = ((feet.x - b.rx) * c - (feet.z - b.rz) * sn) / s - hull.cx
  const lv = (((feet.x - b.rx) * sn + (feet.z - b.rz) * c) / s - hull.cz) * hull.bow
  check(Math.abs(lu) < 0.01 && Math.abs(lv - 0.3 * r.long) < 0.01, 'and she is carried, still at the bow', `at (${lu.toFixed(3)}, ${lv.toFixed(3)}) of ${r.long.toFixed(3)} in the hull`)
  const st = boats.netState()
  check(st.aboard && st.aboard[0] === b.origin && st.boat && st.boat[0] === b.origin && st.boat.length === 6 && st.boat[4] === Math.round(b.v * 1000) / 1000,
    'her pose carries her place aboard and the boat\'s state', JSON.stringify(st.boat))
  // The fourth number is her feet over the hull's datum, which is what keeps a peer on the deck rather than under it.
  check(st.aboard.length === 4 && Math.abs(st.aboard[3] - (feet.y - b.ry)) < 0.001,
    'and her feet\'s height over the hull, so a peer is not left to guess at it', `rise ${st.aboard[3]} of feet ${feet.y.toFixed(3)} over ry ${b.ry.toFixed(3)}`)

  // A teleport lands BETWEEN frames, before the carry: it keeps its landing,
  // whether that is amidships or off the boat, plus the frame's travel.
  const place = (u, v) => { at(u, v); step(); step = null }
  place(0, 0)
  tick(1)
  const mu = ((feet.x - b.rx) * c - (feet.z - b.rz) * sn) / s - hull.cx
  const mv = (((feet.x - b.rx) * sn + (feet.z - b.rz) * c) / s - hull.cz) * hull.bow
  check(boats.aboard && Math.abs(mu) < 0.02 && Math.abs(mv) < 0.02, 'a teleport to amidships before the carry lands her there, still aboard', `at (${mu.toFixed(3)}, ${mv.toFixed(3)})`)
  place(0, 0.3 * r.long)
  tick(1)
  place(3 * r.long, 0)
  const landX = feet.x
  const landZ = feet.z
  tick(1)
  check(!boats.aboard && Math.hypot(feet.x - landX, feet.z - landZ) < b.v / 30, 'a teleport off the boat before the carry leaves her ashore', `${Math.hypot(feet.x - landX, feet.z - landZ).toFixed(3)} m from the landing`)
  place(0, 0)
  tick(1)
  check(boats.aboard, 'and back aboard from a teleport in')

  // Back to the centre: the way dies over a few TAU_DRAG.
  tick(1200)
  check(Math.abs(b.v) < 0.02, 'weight amidships again, twenty seconds later it has all but stopped', `${b.v.toFixed(3)} m/s`)

  // Right in the bow's tip: level ground to the slope rule, and twice the pace.
  check(hull.tip > 0.3 * r.long && inLoop(hull.pad, hull.cx, hull.cz + hull.tip * 0.85 * hull.bow), 'the pad reaches a tip well ahead of the full-ask lever', `${hull.tip.toFixed(3)} of ${r.long.toFixed(3)}`)
  at(0, hull.tip * 0.85)
  tick(1)
  check(boats.aboard && boats.deckAt(feet.x, feet.z) && !boats.deckAt(feet.x + Math.sin(b.ryaw) * hull.bow * 0.5, feet.z + Math.cos(b.ryaw) * hull.bow * 0.5),
    'standing in the tip she is aboard on the deck, and half a metre ahead is not deck')
  tick(1200)
  check(b.v > 4.6 && b.v <= 4.8 + 1e-6, 'weight in the tip gathers twice V_MAX', `${b.v.toFixed(2)} m/s`)
  at(0, 0)
  tick(1500)

  // To one side: the bow swings that way.
  at(0.12 * r.long, 0)
  const yaw1 = b.yaw
  tick(300)
  const swung = Math.atan2(Math.sin(b.yaw - yaw1), Math.cos(b.yaw - yaw1))
  check(Math.abs(swung) > 0.5 && Math.abs(b.w) > 0.3, 'weight to a side swings the boat', `${(swung * 180 / Math.PI).toFixed(0)} deg in 5 s, ${b.w.toFixed(2)} rad/s`)
  // Which way: the bow's world direction moved toward the side she stands on.
  const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw1)
  const bowNow = new THREE.Vector3(0, 0, hull.bow).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw)
  const bowThen = new THREE.Vector3(0, 0, hull.bow).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw1)
  check(bowNow.dot(side) > bowThen.dot(side), 'toward the side the weight is on')

  // The hull is stone: the sole inside, the gunwale over the rail, nothing past the pad.
  const out = new Float64Array(16)
  at(0, 0)
  tick(1)
  const p = player.rig.position
  let n = boats.columnAt(p.x, p.z, 0, out)
  check(n === 1 && Math.abs(out[1] - (b.ry + (soleAt(hull.sole, hull.cx, hull.cz) - hull.keelY) * s)) < 1e-6 && out[0] === b.ry, 'her feet stand on the boards', `${n} span, top ${(out[1] - out[0]).toFixed(3)} m over the keel`)
  const railX = railAt(hull.walk, hull.cx, hull.cz)
  at((railX - hull.cx) * 1.04, 0)
  tick(1)
  n = boats.columnAt(p.x, p.z, 0, out)
  check(n === 1 && Math.abs(out[1] - (b.ry + (hull.gunwaleY - hull.keelY) * s)) < 0.01, 'the gunwale is a step over the boards', `top ${(out[1] - out[0]).toFixed(2)} m over the keel`)
  check(boats.aboard, 'and standing on it she is aboard')
  at((railX - hull.cx) * 1.3, 0)
  tick(1)
  n = boats.columnAt(p.x, p.z, 0, out)
  check(n === 0 && boats.blockTopAt(p.x, p.z) === -Infinity, 'past the pad there is nothing')
  check(boats.aboard === false, 'so she is off the boat there')
  at(0, 0)
  tick(1)
  // The keel is refused where the ground rises to it: turned onto the beach, the way stops.
  b.yaw = hull.bow < 0 ? Math.PI / 2 : -Math.PI / 2
  b.ryaw = b.yaw
  b.x = 3
  b.rx = 3
  b.w = 0
  at(0, 0.3 * r.long)
  tick(600)
  check(boats.aground && b.v === 0 && b.x > 0 && b.x < 3, 'nosed at the beach it grounds and stops short of it', `x ${b.x.toFixed(2)}, ${boats.stats.aground ? 'aground' : 'afloat'}`)

  // The rock: bounded, and no two boats alike.
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  let heaveMax = 0
  let rollMax = 0
  for (let i = 0; i < 600; i++) {
    tick(1)
    boats.hulls.getMatrixAt(0, m)
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3())
    e.setFromQuaternion(q, 'YXZ')
    heaveMax = Math.max(heaveMax, Math.abs(b.ry - b.y))
    rollMax = Math.max(rollMax, Math.abs(e.z))
  }
  check(heaveMax > 0.005 && heaveMax <= 0.03 && rollMax > 0.005 && rollMax <= 3 * Math.PI / 180, 'it rocks, within three centimetres and three degrees',
    `heave to ${(heaveMax * 100).toFixed(1)} cm, roll to ${(rollMax * 180 / Math.PI).toFixed(2)} deg`)
  check(boats.lids.count === 1 && boats.hulls.count === 1, 'one hull, one lid drawn')
  boats.dispose()
  r.dispose()
}

// --- the river --------------------------------------------------------------
{
  console.log('\nthe current carries the boat downstream, rider or none, off the lake and onto the river')
  const w = riverCoast(LEVEL, 1.0, (x) => x >= 5 && x <= 15, [0, 1])
  const r = new Rowboats(new THREE.Scene(), w.field, w.water, { seed: 11, radius: 1200, bank: shippedBank() })
  r.place(0, 0)
  const player = fakePlayer()
  const net = fakeNet('a')
  const boats = new Boats(new THREE.Scene(), r, w.water, player, net)
  const b = firstBoat(r)
  const hull = r.bank.hull
  const s = b.length / r.long
  // Into the channel at z = 40, headed downstream, her feet amidships.
  b.x = 10
  b.z = 40
  b.yaw = hull.bow < 0 ? Math.PI : 0
  const feetAt = (u, v) => {
    const c = Math.cos(b.yaw)
    const sn = Math.sin(b.yaw)
    const lx = (hull.cx + u) * s
    const lz = (hull.cz + v * hull.bow) * s
    player.rig.position.set(b.x + lx * c + lz * sn, b.y + (hull.floorY - hull.keelY) * s, b.z - lx * sn + lz * c)
  }
  let now = 0
  const tick = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      now += dt * 1000
      boats.update(dt, now)
      boats.settle()
    }
  }
  feetAt(0, 0)
  tick(1)
  check(boats.live[0] === b && boats.aboard && boats.authorityOf === b, 'aboard in the channel, its authority')
  tick(600)
  const feet = player.rig.position
  check(Math.abs(b.z - 50) < 0.3 && Math.abs(b.x - 10) < 0.05 && Math.abs(b.v) < 0.05, 'ten seconds later the current has carried it ten metres downstream, no way on', `at (${b.x.toFixed(2)}, ${b.z.toFixed(2)}), ${b.v.toFixed(3)} m/s`)
  const c = Math.cos(b.ryaw)
  const sn = Math.sin(b.ryaw)
  const lu = ((feet.x - b.rx) * c - (feet.z - b.rz) * sn) / s - hull.cx
  const lv = (((feet.x - b.rx) * sn + (feet.z - b.rz) * c) / s - hull.cz) * hull.bow
  check(boats.aboard && Math.abs(lu) < 0.02 && Math.abs(lv) < 0.02, 'and she is carried with it, still amidships', `at (${lu.toFixed(3)}, ${lv.toFixed(3)})`)
  tick(600)
  check(b.z > 59 && b.live && Math.abs(b.y - (LEVEL - DRAFT * b.length)) < 1e-6, 'past the lake\'s footprint it floats on at the river\'s level', `z ${b.z.toFixed(1)}, y ${b.y.toFixed(3)}`)
  // She steps ashore: the boat drifts on, live and hers to report.
  player.rig.position.set(-5, LEVEL + 5, b.z)
  tick(600)
  check(!boats.aboard && b.z > 69 && boats.authorityOf === b && boats.netState().boat !== null && boats.netState().aboard === null,
    'ashore, it drifts on and she still reports it', `z ${b.z.toFixed(1)}, ${boats.authorityOf === b ? 'authority' : 'not authority'}`)
  // Far off, it moors where the river has taken it.
  player.rig.position.set(-5, LEVEL + 5, b.z + 400)
  const zMoor = b.z
  tick(30)
  check(!b.live && boats.live.length === 0 && boats.authorityOf === null && b.z >= zMoor && b.z < zMoor + 1, 'beyond reach it moors where it lies', `z ${b.z.toFixed(1)}`)
  // A relay sample of it from ten seconds ago, nobody aboard: reckoned ten metres down the river.
  player.rig.position.set(-5, LEVEL + 5, 110)
  net.boats = [[b.origin, 10, 100, b.yaw, 0, 0, 10_000]]
  net.boatsSerial++
  tick(20)
  check(b.live && Math.abs(b.x - 10) < 0.05 && Math.abs(b.z - 110) < 0.5, 'a stale sample is carried downstream for its age', `at (${b.x.toFixed(2)}, ${b.z.toFixed(2)})`)
  boats.dispose()
  r.dispose()

  // Set onto the beach broadside, nobody aboard, the current pins it where the keel would touch.
  const w2 = riverCoast(LEVEL, 1.0, (x) => x <= 15, [-1, 0])
  const r2 = new Rowboats(new THREE.Scene(), w2.field, w2.water, { seed: 11, radius: 1200, bank: shippedBank() })
  r2.place(0, 0)
  const boats2 = new Boats(new THREE.Scene(), r2, w2.water, player, fakeNet('a'))
  const b2 = firstBoat(r2)
  b2.x = 10
  b2.z = 0
  b2.yaw = 0
  player.rig.position.set(-5, LEVEL + 5, 0)
  let n2 = 0
  const tick2 = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) { n2 += dt * 1000; boats2.update(dt, n2); boats2.settle() }
  }
  tick2(1200)
  const xPin = b2.x
  tick2(300)
  const keel = DRAFT * b2.length + 0.15
  check(b2.live && xPin > keel && xPin < keel + 0.1 && b2.x === xPin && b2.flow === 1, 'a current onto the beach grounds the boat where the keel would touch and holds it', `x ${xPin.toFixed(2)} for a keel at ${keel.toFixed(2)}`)
  boats2.dispose()
  r2.dispose()
}

// --- the net ----------------------------------------------------------------
{
  console.log('\na peer\'s boat is dead-reckoned from its samples without a step')
  const r = new Rowboats(new THREE.Scene(), world.field, world.water, { seed: 11, radius: 1200, bank: shippedBank() })
  r.place(0, 0)
  const player = fakePlayer()
  const net = fakeNet('b')
  const boats = new Boats(new THREE.Scene(), r, world.water, player, net)
  const b = firstBoat(r)
  const hull = r.bank.hull
  player.rig.position.set(b.x + 5, LEVEL, b.z)
  let now = 0
  let worstJump = 0
  let lastRx = 0
  let lastRz = 0
  const tick = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      now += dt * 1000
      boats.update(dt, now)
      boats.settle()
      worstJump = Math.max(worstJump, Math.hypot(b.rx - lastRx, b.rz - lastRz))
      lastRx = b.rx
      lastRz = b.rz
    }
  }
  tick(1)
  check(boats.live[0] === b && !boats.aboard, 'the boat beside her is live and she is ashore')
  // A peer with a lower id aboard: its samples drive the boat, at 20 Hz, 1 m/s ahead.
  const peer = { id: 'a', alpha: 1, aboard: [b.origin, 0, 0, 0.42], pose: new Array(21).fill(0) }
  net.peers.set('a', peer)
  const fx = Math.sin(b.yaw) * hull.bow
  const fz = Math.cos(b.yaw) * hull.bow
  let sx = b.x
  let sz = b.z
  worstJump = 0
  for (let i = 0; i < 100; i++) {
    sx += fx * 1.0 * 0.05
    sz += fz * 1.0 * 0.05
    net.boats = [[b.origin, sx, sz, b.yaw, 1.0, 0, 0]]
    net.boatsSerial++
    tick(3)
  }
  const err = Math.hypot(b.rx - (sx + fx * 0.05), b.rz - (sz + fz * 0.05))
  check(boats.authorityOf === null && Math.abs(b.v - 1.0) < 1e-9, 'she is not its authority; its speed is the sample\'s', `${b.v} m/s`)
  check(worstJump < 0.03, 'the drawn boat never steps more than a frame\'s travel', `worst ${(worstJump * 100).toFixed(1)} cm a frame at 1 m/s`)
  check(err < 0.1, 'and it draws within a decimetre of the peer\'s reckoning', `${(err * 100).toFixed(1)} cm off`)
  // The peer's pose is anchored to the hull, hands and all.
  peer.pose[0] = 0; peer.pose[2] = 0; peer.pose[7] = 1; peer.pose[9] = 1
  const [anchored] = boats.anchorPeers([peer])
  check(Math.abs(anchored.pose[0] - b.rx) < 1e-9 && Math.abs(anchored.pose[2] - b.rz) < 1e-9 && Math.abs(anchored.pose[7] - (b.rx + 1)) < 1e-9,
    'a peer aboard is drawn at its place in the hull, its hands moved with it')
  check(Math.abs(anchored.foot - (b.ry + 0.42)) < 1e-9, 'and its feet stand on the deck at the height it reports, off THIS client\'s hull', `foot ${anchored.foot?.toFixed(3)} of ry ${b.ry.toFixed(3)}`)
  // A peer from a client too old to send the rise has none, and avatar-rig.js goes back to reading the surface.
  const [old] = boats.anchorPeers([{ id: 'b', alpha: 1, aboard: [b.origin, 0, 0], pose: new Array(21).fill(0) }])
  check(old.foot === undefined, 'a peer that sends no rise is left without one, to be guessed at as before')
  // The peer steps off and the last sample ages: the boat glides to a stop everywhere alike.
  net.peers.clear()
  net.boats = [[b.origin, sx, sz, b.yaw, 1.0, 0, 8000]]
  net.boatsSerial++
  tick(60)
  check(Math.abs(b.v) < 0.2, 'an eight-second-old sample lands already spent', `${b.v.toFixed(3)} m/s`)
  check(boats.live.length <= MAX_LIVE, 'within the live cap')
  boats.dispose()
  r.dispose()
}

console.log(failures ? `\n${failures} boat check(s) FAILED` : '\nall boat checks passed')
process.exit(failures ? 1 : 0)
