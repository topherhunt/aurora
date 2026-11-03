// Node-side gates for walking a castle's interior with the real Player (src/player.js) on its collision (src/v2/castles/solids.js).
//
//   node scripts/check-castle-walk.mjs
//
// A flood of her steps from every door and ladder foot, through the walk's own climb and head-room tests, that leaves a chamber
// unentered or the dungeon's key or (unlocked) chest unreached; and a spiral she cannot drive down or up end to end, along the post,
// the middle of the treads or the drum, or that pops her up onto a landing's slab on the way down. The flood is slow, so it sweeps
// few seeds: ones whose one-cell towers are entered only by their spirals, and 258641, whose dungeon is reached only by one; the flood
// runs with every ward open. A shut ward that lets her step through its doorway, or an opened one that does not. And a ladder she
// cannot climb by walking at it, or that she starts climbing walking past it. A bed she lands on but is not laid in, or has nowhere
// beside to get up onto. A teleport lob into the side of a prop that lands under the floor it stands on. A ward's gem she can aim at through its membrane, and
// wards another player opened that do not dissolve. A runebook drawn in the wrong one of the interior and the exterior.

import THREE from '../src/three-instance.js'
import { Player } from '../src/player.js'
import { WalkSurface, lobLanding } from '../src/v2/walk.js'
import { castleLayout, CASTLE } from '../src/v2/castles/layout.js'
import { castleSolids, interiorSpans, ladderFoot, SPANS, wardFrame } from '../src/v2/castles/solids.js'
import { Climb } from '../src/v2/climb.js'
import { SEG, SPIRAL } from '../src/v2/castles/spiral.js'
import { roomPlan, roomProps } from '../src/v2/castles/furnish.js'
import { interiorWarp, warpedProp } from '../src/v2/castles/shell.js'
import { besideBed, feetOnBed } from '../src/v2/vitals.js'

let failures = 0
function check(ok, label, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const SH = CASTLE.storey * CASTLE.tall
/** The real Player on castle interior collision. `hint` is the storey height spans are read about, as the game reads them at her feet. */
function rig(it) {
  const at = { hint: 0 }
  const stone = {
    columnAt(x, z, _m, out, foot) {
      const n = interiorSpans(it, x, z, (foot === undefined ? at.hint : foot) + 0.5)
      for (let i = 0; i < n; i++) { out[i * 2] = SPANS.LO[i]; out[i * 2 + 1] = SPANS.HI[i] }
      return n
    },
    deckAt: () => true,
  }
  const surface = new WalkSurface({ heightAt: () => it.base }, stone, { trunkAt: () => false })
  const group = new THREE.Group(), cam = new THREE.PerspectiveCamera()
  cam.position.y = 1.6; group.add(cam)
  return { at, surface, group, player: new Player(group, cam, surface) }
}

// Flood: 0.4 m grid cells crossed in 0.1 m steps, each step one the walk would take.
const G = 0.4, SUB = 0.1, N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
const missed = [], unkeyed = [], unlooted = []
for (const seed of [1, 3, 8, 258641]) {
  const lay = castleLayout(seed)
  if (!lay.stats.ok) throw new Error(`castle ${seed} fails its layout; pick a seed that passes`)
  const sol = castleSolids(lay), { at, surface, player } = rig(sol.it)
  sol.it.open = (1 << lay.wards.length) - 1
  const seen = new Map(), queue = []
  const push = (x, z, y) => {
    const i = Math.round(x / G), j = Math.round(z / G), k = `${i},${j},${Math.round(y * 20)}`
    if (!seen.has(k)) { seen.set(k, [i * G, j * G, y]); queue.push([i * G, j * G, y]) }
  }
  const flood = () => {
    while (queue.length) {
      const [x0, z0, y0] = queue.pop()
      for (const [a, b] of N8) {
        const len = Math.hypot(a, b) * G, n = Math.ceil(len / SUB), dx = a * G / n, dz = b * G / n
        let x = x0, z = z0, y = y0, ok = true
        for (let s = 0; s < n && ok; s++) {
          at.hint = y
          const h = player._walkable(x, z, y, dx, dz, len / n)
          ok = !Number.isNaN(h) && surface.fits(x + dx, z + dz, Math.max(y, h))
          if (ok) { x += dx; z += dz; y = surface.heightAt(x, z, y) }
        }
        if (ok && y > -50) push(x, z, y)
      }
    }
  }
  const near = ([qx, qy, qz]) => [...seen.values()].some(([x, z, y]) => Math.abs(y - qy) < 1.5 && Math.hypot(x - qx, z - qz) < 1.2)
  for (const d of sol.portals.doors) push(d.in[0], d.in[2], d.in[1])
  for (const l of sol.portals.ladders) push(l.down[0], l.down[2], l.down[1])
  flood()
  const { key, chest, door } = sol.portals.dungeon
  if (!near(key)) unkeyed.push(seed)
  sol.it.unlocked = true
  for (const p of seen.values()) if (Math.hypot(p[0] - door.x, p[1] - door.z) < 3) queue.push(p)
  flood()
  if (!near(chest)) unlooted.push(seed)
  const pts = [...seen.values()]
  const inside = (r, x, z) => x > r[0] + 0.2 && x < r[2] - 0.2 && z > r[1] + 0.2 && z < r[3] - 0.2
  for (const c of roomPlan(lay).chambers) if (!pts.some(([x, z, y]) => Math.abs(y - c.k * SH) < 0.05 && inside(c.rect, x, z))) missed.push(`${seed}:${c.node.id}@k${c.k}`)
}
check(!missed.length, 'she can walk into every chamber from the doors and ladder feet', missed.join(' '))
check(!unkeyed.length, "she can walk to the dungeon's key", unkeyed.join(' '))
check(!unlooted.length, "she can walk to the dungeon's chest once its door is unlocked", unlooted.join(' '))

// Wards: from 0.6 m before each one on its gem side, straight through its doorway 1.5 m (an outer door's 0.4 m: its reveal ends at the
// leaves, where the portal takes her), with it shut and then opened.
const leaky = [], stuck = []
for (const seed of [1, 3, 8]) {
  const lay = castleLayout(seed), it = castleSolids(lay).it, { at, surface, player } = rig(it)
  lay.wards.forEach((w, i) => {
    const m = wardFrame(w), [ux, uz] = m.axis === 'x' ? [m.sgn, 0] : [0, m.sgn]
    const outer = !w.tunnel && (w.edge.kind === 'bridge' || w.edge.a.kind !== 'room' || w.edge.b.kind !== 'room')
    const through = () => {
      let x = m.axis === 'x' ? m.a - m.sgn * 0.6 : m.c, z = m.axis === 'x' ? m.c : m.a - m.sgn * 0.6, y = m.y
      for (let s = 0; s < (outer ? 4 : 15); s++) {
        at.hint = y
        const h = player._walkable(x, z, y, ux * 0.1, uz * 0.1, 0.1)
        if (Number.isNaN(h) || !surface.fits(x + ux * 0.1, z + uz * 0.1, Math.max(y, h))) return false
        x += ux * 0.1; z += uz * 0.1; y = surface.heightAt(x, z, y)
      }
      return true
    }
    it.open = 0
    if (through()) leaky.push(`${seed}:${i}`)
    it.open = 1 << i
    if (!through()) stuck.push(`${seed}:${i}`)
  })
}
check(!leaky.length, 'a shut ward stops her in its doorway', leaky.join(' '))
check(!stuck.length, 'an opened ward lets her walk through its doorway', stuck.join(' '))

// Ladders, with the real Climb: walking at one from 1 m before its foot (0.6 m before a drum's, whose well lies ahead) climbs it until her head meets the trap door, which takes
// her out; walking past along its wall, on its foot line or 0.4 m out, from 1.5 m to one side toward the other, never starts a climb.
const unclimbed = [], snagged = []
let passes = 0
for (const seed of [1, 3, 8]) {
  const lay = castleLayout(seed), sol = castleSolids(lay), { at, group, player, surface } = rig(sol.it), ls = sol.portals.ladders
  const climb = new Climb(player, [{ ladderAt: (x, z, r, y) => {
    const l = ladderFoot(ls, x, z, r, y)
    return l === null ? null : { x: l.foot[0], z: l.foot[1], ux: l.ux, uz: l.uz, bottom: l.bottom, top: l.top, act: { kind: 'leave' } }
  }, rungAt: () => null }], (act) => { climb.out = act })
  const walk = (x, z, y, gx, gz, secs, held) => {
    const p = group.position
    player.teleportTo(x, z, y)
    group.rotation.set(0, Math.atan2(-gx, -gz), 0)
    group.updateMatrixWorld(true)
    climb.out = null
    let top = y
    for (let t = 0; t < secs * 72 && climb.out === null; t++) {
      at.hint = player.standY
      const input = { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false }
      climb.desk(1 / 72, input, gx, gz)
      player.update(1 / 72, input)
      top = Math.max(top, p.y)
      if (player.held) held.n++
    }
    return top
  }
  ls.forEach((l, i) => {
    const tag = `${seed}:${i}`, held = { n: 0 }
    at.hint = l.bottom
    const back = surface.fits(l.foot[0] + l.ux, l.foot[1] + l.uz, l.bottom) ? 1 : 0.6
    const top = walk(l.foot[0] + l.ux * back, l.foot[1] + l.uz * back, l.bottom, -l.ux, -l.uz, 15, held)
    if (climb.out === null || climb.out.kind !== 'leave' || top < l.top - 0.01) unclimbed.push(`${tag} to ${(top - l.bottom).toFixed(1)} m`)
    for (const out of [0, 0.4]) for (const s of [-1, 1]) {
      const px = -l.uz * s, pz = l.ux * s, x = l.foot[0] + l.ux * out - px * 1.5, z = l.foot[1] + l.uz * out - pz * 1.5
      at.hint = l.bottom
      if (!surface.fits(x, z, l.bottom)) continue
      passes++
      held.n = 0
      walk(x, z, l.bottom, px, pz, 3 / 1.4, held)
      if (held.n || climb.out !== null) snagged.push(`${tag}${s < 0 ? '-' : '+'}${out}`)
    }
  })
}
check(!unclimbed.length, 'walking at a ladder climbs it until her head meets the trap door, which takes her out onto the roof', unclimbed.join(' '))
check(!snagged.length, `walking past a ladder along its wall never climbs it (${passes} passes)`, snagged.join(' '))

// Drive: forward only (as in VR), steering a lead point round the helix at radius RAD, down from each column's top and up from its foot.
const LEAD = 0.6, RADS = [SPIRAL.post + 0.35, (SPIRAL.post + SPIRAL.well) / 2, SPIRAL.well - 0.25]
const stalled = [], popped = []
let runs = 0
for (let seed = 1; seed <= 5; seed++) {
  const lay = castleLayout(seed)
  if (!lay.stats.ok) continue
  const it = castleSolids(lay).it, { at, group, player } = rig(it)
  const cols = []
  for (const s of [...it.spirals].sort((a, b) => a.k - b.k)) {
    const col = cols.find((c) => c.at(-1).k === s.k - 1 && c[0].x === s.x && c[0].z === s.z)
    if (col) col.push(s); else cols.push([s])
  }
  for (const col of cols) for (const RAD of RADS) for (const dir of [-1, 1]) {
    runs++
    const { x: cx, z: cz, hand } = col[0], lo = col[0].k * SH, hi = (col.at(-1).k + 1) * SH
    // Up from the first tread's foot; down from the last flight's landing.
    const a = dir < 0 ? col.at(-1).a0 + hand * 15.5 * SEG : col[0].a0 - hand * SEG / 2
    const start = dir < 0 ? hi : lo, goal = dir < 0 ? lo : hi, p = group.position
    p.set(cx + Math.cos(a) * RAD, start, cz + Math.sin(a) * RAD)
    player.smoothY = player.standY = start; player._fallTop = null
    let prev = start, pops = 0
    for (let t = 0; t < 700 * col.length && Math.abs(player.standY - goal) > 0.05; t++) {
      const ang = Math.atan2(p.z - cz, p.x - cx) + dir * hand * LEAD / RAD
      group.rotation.set(0, Math.atan2(-(cx + Math.cos(ang) * RAD - p.x), -(cz + Math.sin(ang) * RAD - p.z)), 0)
      group.updateMatrixWorld(true)
      at.hint = player.standY
      player.update(1 / 72, { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: false })
      if (dir < 0 && player.standY > prev + 0.25) pops++
      prev = player.standY
    }
    const tag = `${seed}:${cx},${cz}k${col[0].k}-${col.at(-1).k} r${RAD.toFixed(2)} ${dir < 0 ? 'down' : 'up'}`
    if (Math.abs(player.standY - goal) > 0.05) stalled.push(`${tag} at ${player.standY.toFixed(1)}`)
    if (pops) popped.push(tag)
  }
}
check(!stalled.length, `she can drive every spiral down and up, along its post, treads and drum (${runs} runs)`, stalled.slice(0, 6).join(' | '))
check(!popped.length, "driving down a spiral never pops her up onto a landing's slab", popped.slice(0, 6).join(' | '))

// The wards' gems as main.js aims at them, on a stubbed canvas (WardSet draws its halo on one).
globalThis.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) }
const { WardSet, WARD_LOOK } = await import('../src/v2/render/castle-wards.js')
const wrongSide = [], rightSide = [], caught = [], wrongPlace = []
for (const seed of [1, 3, 215679, 311021]) {
  const lay = castleLayout(seed), P = castleSolids(lay).portals
  const set = new WardSet(P, null, 0, 0)
  P.wards.forEach((w, i) => {
    for (const s of [1, -1]) {
      const o = new THREE.Vector3(w.x + w.nx * 0.6 * s, w.gem[1], w.z + w.nz * 0.6 * s), d = new THREE.Vector3(...w.gem).sub(o).normalize()
      const hit = set.gemOn(o, d, 3)
      if (s > 0 && hit !== i) rightSide.push(`${seed}:${i}`)
      if (s < 0 && hit === i) wrongSide.push(`${seed}:${i}`)
    }
  })
  set.catchUp(0b101, 0b11)
  set.update(0, WARD_LOOK.open + 0.1, null)
  if (set.wards[0].g.visible || set.wards[2].g.visible || !set.wards[1].g.visible || set.books[1].live || !set.books[2].live) caught.push(seed)
  const up = P.books.flatMap((b, j) => (b.roof ? [j] : []))
  if (!up.length) throw new Error(`castle ${seed} has no tower-top runebook; pick a seed that has`)
  const inRooms = new WardSet(P, null, 0, 0), onRoofs = new WardSet({ wards: [], books: P.books }, null, 0, 1 << up[0], true)
  P.books.forEach((b, j) => {
    if (inRooms.books[j].g.visible === b.roof) wrongPlace.push(`${seed}:${j} indoors`)
    if (onRoofs.books[j].g.visible !== (b.roof && j !== up[0])) wrongPlace.push(`${seed}:${j} on the roofs`)
  })
  if (up.length > 1) {
    onRoofs.catchUp(0, (1 << up[0]) | (1 << up[1]))
    for (let i = 0; i < 40; i++) onRoofs.update(i * 0.1, 0.1, null)
    if (onRoofs.books[up[1]].g.visible) wrongPlace.push(`${seed}:${up[1]} stays after it is spent`)
  }
}
check(!wrongPlace.length, 'indoors draws only the rooms\' runebooks, the exterior only the tower tops\' still unspent', wrongPlace.slice(0, 6).join(' '))
check(!rightSide.length, "she can aim at a shut ward's gem from its own side", rightSide.slice(0, 6).join(' '))
check(!wrongSide.length, "she cannot aim at a shut ward's gem through its membrane", wrongSide.slice(0, 6).join(' '))
check(!caught.length, 'wards and books another player opened and spent dissolve here, and no others', caught.join(' '))

// Beds: landing on the middle of one is lying in it, and getting up finds floor beside it.
const badBeds = []
for (const seed of [1, 3, 7, 215679, 311021]) {
  const sol = castleSolids(castleLayout(seed)), { surface } = rig(sol.it)
  for (const b of sol.portals.beds) {
    const land = surface.heightAt(b.x, b.z, b.floor + 1.2)
    let stand = true
    try { besideBed(b, surface) } catch { stand = false }
    if (!stand || !feetOnBed(b, { x: b.x, y: land, z: b.z }, 0)) badBeds.push(`${seed}@${b.x.toFixed(1)},${b.z.toFixed(1)}`)
  }
}
check(!badBeds.length, 'every castle bed lays her in it where she lands on it, and has floor beside it to get up onto', badBeds.slice(0, 6).join(' '))

// Lobs as main.js aimTeleport throws them (6.5 m/s, 0.04 s samples, bisected), at every prop from round it: a crossing into its
// side lands on the floor she threw from, never the storey or dungeon under it.
const sunk = []
for (const seed of [215679, 311021]) {
  const lay = castleLayout(seed), sol = castleSolids(lay), { at, surface } = rig(sol.it), warp = interiorWarp(lay)
  for (const o of roomProps(lay).map((p) => warpedProp(warp, p))) for (let a = 0; a < 8; a++) {
    const fx = o.x + Math.cos(a * Math.PI / 4) * 1.6, fz = o.z + Math.sin(a * Math.PI / 4) * 1.6, fy = surface.heightAt(fx, fz, o.y + 0.3)
    if (Math.abs(fy - o.y) > 0.01 || !surface.fits(fx, fz, fy, null)) continue
    at.hint = fy
    for (const pitch of [-0.5, -0.35, -0.2, 0]) {
      const h = Math.atan2(o.z - fz, o.x - fx), d = [Math.cos(h) * Math.cos(pitch), Math.sin(pitch), Math.sin(h) * Math.cos(pitch)]
      const P = (t) => ({ x: fx + d[0] * 6.5 * t, y: fy + 1.2 + d[1] * 6.5 * t - 4.905 * t * t, z: fz + d[2] * 6.5 * t })
      const clear = (t) => { const p = P(t); return p.y > sol.it.base && surface.ceilingAt(p.x, p.z, p.y) !== -Infinity }
      let prev = 0
      for (let i = 1; i < 40; i++) {
        if (clear(i * 0.04)) { prev = i * 0.04; continue }
        let lo = prev, hi = i * 0.04
        for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (clear(m)) lo = m; else hi = m }
        if (fy - lobLanding(surface, P(lo), P(hi), 1).y > 1) sunk.push(`${seed}:${o.kind}@${o.x.toFixed(1)},${o.y},${o.z.toFixed(1)}`)
        break
      }
    }
  }
}
check(!sunk.length, 'a teleport lob into the side of a castle prop lands on the floor it stands on, not the storey under it', `${sunk.length}: ${sunk.slice(0, 4).join(' ')}`)

console.log(failures ? `\n${failures} FAILED` : '\nall castle walk checks passed')
process.exit(failures ? 1 : 0)
