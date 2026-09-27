// Node-side gates for the leafkin (src/v2/render/leafkin.js, DESIGN.md §30).
//
//   node scripts/check-leafkin.mjs
//
// The shipped GLB is checked for shape as the snowman's is. Then one leafkin
// on a flat stand-in ground: placed out in its wood on its chapter's first tick,
// met mid-chapter replayed hidden and silent; it roams the disc on arcs,
// gathers the caps its ground holds into a bundle of five, is startled by her
// feet, flees round walls home and comes out EMPTY_S on, makes for home
// HOMING_S before the turn. Two instances on different frame times agree to
// the bit. Two clients over a lagged relay send nothing but her frights and
// picks, roll back to hear one late and agree again; a late joiner replays to
// the same leafkin. Last, the real overworld's LeafkinGround: its stone a
// superset of the placed rocks, its caps and trunks the placed ones, its cost.

import * as THREE from 'three'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  Leafkin, CLIPS, LOD_TIERS, MAX, PUPPETS, SIZE_M, SIZE_VAR, ROAM_M, RETARGET_S, OUT_M, OUT_FAR_M, SEEK_M, GATHER_KEY, GIVE_UP_S, STARTLE_M, STARTLE_S, FINAL_M, HOME_M, EMPTY_S, HOMING_S, CHATTER_S, WHIMPER_S, SQUEAL_S, CARRY_SPAN, ARC_M, ARC_CURVE,
} from '../src/v2/render/leafkin.js'
import { LeafkinGround, CELL, OPEN, BLOCKED } from '../src/v2/render/leafkin-ground.js'
import { Hands, CARRY_MAX, CARRIERS, POOL_CAP, LOOSE_MAX } from '../src/v2/hands.js'
import { MOUTH_STEP_M, MOUTH_SINK_M } from '../src/v2/render/entrances.js'
import { LEAD_TICKS } from '../src/v2/render/net-ease.js'
import { CRITTER_GLB, TIER_TINTS, critterTier, cullRange, setTierTint } from '../src/v2/render/critters.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_HZ, TICK_S, chapterOf, tickAfter, tickOf } from '../src/sim/score.js'
import { mulberry32 } from '../src/sim/mathx.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const swing = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const fmt = (v) => v.toFixed(2)

// --- the shipped asset ---------------------------------------------------------------
const url = CRITTER_GLB.leafkin
const file = new URL(`../public/${url}`, import.meta.url)
if (!fs.existsSync(file)) {
  console.log(`  FAIL ${url} is shipped -- run tools/creatures/ship-biped.mjs\n\n1 failing -- the GLB must ship before the leafkin can be checked`)
  process.exit(1)
}
const { json, bin } = readGlb(file)
const id = 'leafkin'
const roster = CREATURES.find((c) => c.id === id)
let biped = null
{
  const meshes = json.meshes ?? []
  const names = meshes.map((m) => m.name)
  check(meshes.length === LOD_TIERS && names.join(',') === [id, ...Array.from({ length: LOD_TIERS - 1 }, (_, k) => `${id}-lod${k + 1}`)].join(','), `${id}: one mesh per rung of the ladder, the rig then lod1 up, in the one file`, names.join(','))
  const prim = meshes[0]?.primitives[0]
  const tris = meshes.map((m) => (m.primitives[0] ? json.accessors[m.primitives[0].indices].count / 3 : 0))
  // skin-ladder.mjs targets fractions of the top, and a tier that drops a whole loose piece lands under its target: the budget holds, the halving need not.
  check(tris.every((t, k) => t > 0 && t <= tris[0] / 2 ** k + 1 && (k === 0 || t < tris[k - 1])), `${id}: each rung is within its budget, the top halved per rung`, tris.join('/'))
  const skinned = (json.nodes ?? []).filter((n) => n.skin !== undefined)
  check(json.skins?.length === 1 && skinned.length === LOD_TIERS && skinned.every((n) => n.skin === 0), `${id}: ONE skeleton, worn by every rung`, `${json.skins?.[0]?.joints.length} joints`)
  const clips = (json.animations ?? []).map((a) => a.name)
  const human = fs.readdirSync(new URL('../tools/creatures/anim/clips/human/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  check(human.every((n) => clips.includes(n)) && clips.length === human.length, `${id}: the whole human clip library, ${human.length} clips`, clips.join(' '))
  check(CLIPS.every((n) => clips.includes(n)) && clips.includes('gather') && clips.includes('run-carry'), `${id}: including every clip the layer plays, the gather and the run-carry among them`, CLIPS.join(' '))
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check(Object.values(durs).every((d) => d > 0.2), `${id}: no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))
  check(Math.abs(durs['run-carry'] - durs.run) < 1e-6, `${id}: the run-carry is the run's length, so its speed is the run's`, `${durs['run-carry']?.toFixed(2)} vs ${durs.run?.toFixed(2)}`)
  biped = json.scenes?.[json.scene ?? 0]?.extras?.biped
  check(biped !== undefined && biped.span > 0 && biped.height > 0 && biped.width > 0 && biped.sizeM === roster.sizeM && biped.frame && Number.isFinite(biped.frame.yaw), `${id}: the scene carries the biped extras, at the roster's ${roster.sizeM} m`, biped && `span ${biped.span.toFixed(3)} width ${biped.width.toFixed(3)} height ${biped.height.toFixed(3)}`)
  check(biped && biped.gait.walk > 0 && biped.gait.run > biped.gait.walk && Object.keys(biped.gait).length === 2, `${id}: walk and run carry a ground speed each, walk under run`, biped && Object.entries(biped.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  const jointNames = new Set([...joints].map((j) => json.nodes[j].name))
  check(biped?.legs?.length === 2 && biped.legs.every((l) => l.chain.length >= 3 && l.chain.every((n) => jointNames.has(n))), `${id}: two legs named, hip to foot, on the skeleton's joints`)
  if (biped && prim) {
    const p = readAccessor(json, bin, prim.attributes.POSITION)
    const c = Math.cos(biped.frame.yaw), s = Math.sin(biped.frame.yaw)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      const v = [c * p[i] + s * p[i + 2] + biped.frame.t[0], p[i + 1] + biped.frame.t[1], -s * p[i] + c * p[i + 2] + biped.frame.t[2]]
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    check(Math.abs(lo[1]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[2] + hi[2]) < 1e-4, `${id}: framed, the bind pose stands on y = 0 with its feet under its middle`)
    check(Math.abs(ext[0] - biped.span) < 1e-4 && Math.abs(ext[1] - biped.height) < 1e-4 && Math.abs(ext[2] - biped.width) < 1e-4 && ext[1] > ext[2], `${id}: the extras are those extents, and it stands taller than it is wide`, ext.map((e) => e.toFixed(3)).join(' x '))
  }
  const image = json.images?.[0]
  const px = shipTexPx(roster)
  check(json.images?.length === 1 && image?.uri === `${id}.webp` && image.bufferView === undefined, `${id}: the one image is the packed WebP beside the GLB`)
  if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
    const { width, height: h } = webpSize(fs.readFileSync(new URL(image.uri, file)))
    check(width === px && h === px, `${id}: the colour map is ${px}px square`, `${width}x${h}`)
  } else check(false, `${id}: the WebP is shipped`)
}
if (!biped) {
  console.log(`\n${failures} failing -- the extras must ship before the leafkin can be checked`)
  process.exit(1)
}

// --- a stand-in asset: a slab on a skeleton of a spine and two legs, the shipped numbers ---------
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [side, sz] of [['L', 1], ['R', -1]]) {
    const hip = new THREE.Bone()
    hip.name = `Hip${side}`
    hip.position.set(0, biped.height * 0.55, sz * biped.width * 0.3)
    const knee = new THREE.Bone()
    knee.name = `Knee${side}`
    knee.position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    const foot = new THREE.Bone()
    foot.name = `Foot${side}`
    foot.position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(hip)
    hip.add(knee)
    knee.add(foot)
    bones.push(hip, knee, foot)
    legs.push({ id: side, chain: [hip.name, knee.name, foot.name] })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
    const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width, LOD_TIERS - k, 1, 1).translate(0, biped.height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const clips = json.animations.map((a) => {
    const dur = Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))
    return new THREE.AnimationClip(a.name, dur, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])])
  })
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped, legs }
}

// --- the stand-in world: a flat field, walls of trunks when asked, caps where they are put, one mouth ------
const GROUND = 40
const KEY = 'hollow:0,0'
// Walls of trunks, each a segment `[x0, z0, x1, z1]` of WALL_R about its line.
const WALL_R = 0.5
const GROW = CELL * Math.SQRT1_2
const nearSegment = (x, z, [x0, z0, x1, z1]) => {
  const dx = x1 - x0, dz = z1 - z0
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)))
  return [x0 + t * dx, z0 + t * dz]
}
const inWall = (walls, x, z) => walls.some((seg) => { const [px, pz] = nearSegment(x, z, seg); return Math.hypot(px - x, pz - z) < WALL_R })
/** LeafkinGround's shape over the flat field: a cell blocked by a wall grown by half its diagonal, as the real one grows a trunk. */
class Ground {
  constructor(caps = []) { this.walls = []; this.caps = caps }
  cell(x, z) {
    const cx = Math.round(x / CELL) * CELL, cz = Math.round(z / CELL) * CELL
    for (const seg of this.walls) { const [px, pz] = nearSegment(cx, cz, seg); if (Math.hypot(px - cx, pz - cz) < WALL_R + GROW) return BLOCKED }
    return OPEN
  }
  capsNear(x, z, reach, out) {
    for (const [cx, cz] of this.caps) if (Math.hypot(cx - x, cz - z) <= reach) out.push(cx, cz)
    return out
  }
}
// The boulder the walker sees: its top over everything behind BOULDER.face, so the drawn pose's cap at the arch is checked.
const BOULDER = { on: false, face: 0.05, top: GROUND + 3 }
const walk = { heightAt: (x) => (BOULDER.on && x < BOULDER.face ? BOULDER.top : GROUND) }
const water = { isSubmerged: () => false, levelAt: () => null }
const mouth = (key = KEY) => ({ key, x: 0, y: GROUND, z: 0, nx: 1, nz: 0, r: 8, ax: -MOUTH_STEP_M - MOUTH_SINK_M, ay: GROUND - 0.05, az: 0, holeX: -1, holeZ: 0, state: {}, flank: [], flankReach: 0 })
const entrancesOf = (...list) => ({ list, sites(into) { into.push(...this.list); return into } })

const capGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.1, 0)
capGeo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(4).fill(1), 1))
const capMat = new THREE.MeshBasicMaterial()
const CAP_SPAN = 0.2
/** Caps at fixed spots, the mushrooms' pickAt/take/onTake shape over instance arrays. */
class Caps {
  constructor(spots) {
    this.instX = Float32Array.from(spots, (s) => s[0])
    this.instY = new Float32Array(spots.length).fill(GROUND)
    this.instZ = Float32Array.from(spots, (s) => s[1])
    this.alive = new Set(spots.map((_, i) => i))
    this.taken = []
    this.onTake = null
  }
  pickAt(x, y, z, reach) {
    let best = null, bestD = reach
    for (const id of this.alive) {
      const d = Math.hypot(this.instX[id] - x, this.instY[id] + CAP_SPAN / 2 - y, this.instZ[id] - z) - CAP_SPAN / 2
      if (d < bestD) { bestD = d; best = { dist: Math.max(0, d), id, tile: null, k: 0, size: CAP_SPAN } }
    }
    return best
  }
  take(hit) {
    if (!this.alive.delete(hit.id)) throw new Error(`Caps.take: ${hit.id} is not standing`)
    this.taken.push(hit.id)
    if (this.onTake) this.onTake(this.instX[hit.id], this.instZ[hit.id])
    return { kind: 'mushroom', name: 'cap', size: CAP_SPAN, geometry: capGeo, material: capMat, color: null, scale: [1, 1, 1], stowable: true }
  }
}
/** Her hand on a cap: the pick the mushrooms tell the leafkin of. */
const pick = (caps, x, z) => caps.take(caps.pickAt(x, GROUND + 0.1, z, 0.5))
const handsOf = () => new Hands(new THREE.Scene(), { walk: { ...walk, normalAt: (x, z, e, o = { x: 0, y: 1, z: 0 }) => o, obstacleAt: () => null }, water, haptic() {}, stow: () => false, thud() {}, splash() {}, rand: mulberry32(5) })

// A chapter's first second at the mouth; her feet just outside its roam (stepped, never startling it), and out of its reach.
const START = chapterOf(100000, KEY).start
const NEAR = { x: 0, y: GROUND, z: ROAM_M + 10 }
const FAR = { x: 400, y: GROUND, z: 0 }
const head = (feet) => ({ x: feet.x, y: feet.y + 1.6, z: feet.z })
const make = ({ spots = [], ground = new Ground(spots), entrances = entrancesOf(mouth()), mushrooms = spots.length ? new Caps(spots) : null, hands = null } = {}) =>
  new Leafkin(new THREE.Scene(), { ground, walk, entrances, mushrooms, hands, asset: makeAsset() })
const one = (w) => w.byKey.values().next().value
/** Frames at `hz` from `t` with her feet at `feet`, `each(c, t)` after every one. Returns the time reached. */
function run(w, t, seconds, feet, each = null, hz = 60) {
  const frames = Math.round(seconds * hz)
  for (let i = 0; i < frames; i++) {
    t += 1 / hz
    w.update(feet, head(feet), t, 1 / hz)
    if (each) each(one(w), t)
  }
  return t
}
/** Frames at 60 Hz from `t` until its leafkin is caught up to the frame. Returns the time reached. */
function meet(w, feet, t, limit = 30) {
  for (let i = 0; i < limit * 60; i++) {
    w.update(feet, head(feet), (t += 1 / 60), 1 / 60)
    if (one(w)?.tick === tickOf(t)) break
  }
  return t
}
const same = (a, b) => a && b && a.tick === b.tick && a.x === b.x && a.z === b.z && a.heading === b.heading && a.state === b.state && a.rs === b.rs && a.bundle === b.bundle && a.clip === b.clip && a.eaten.length === b.eaten.length
// Where the chapter at START places the stand-in's leafkin, and a spot `[f, s]` metres forward and to its left of there, as it faces: the caps and walls staged before it are staged about here.
const OUT = (() => { const w = make(); meet(w, NEAR, START); const { x, z, heading } = one(w); w.dispose(); return { x, z, heading } })()
const before = ([f, s]) => [OUT.x + f * Math.cos(OUT.heading) - s * Math.sin(OUT.heading), OUT.z - f * Math.sin(OUT.heading) - s * Math.cos(OUT.heading)]
/** Her feet beside it: a stride off on the side away from the mouth. */
const beside = (c) => ({ x: c.x + 1, y: GROUND, z: c.z })

// --- construction ---------------------------------------------------------------
console.log('\nconstruction')
{
  const caps = new Caps([])
  const w = make({ mushrooms: caps })
  check(w.loaded && w.asset.height === biped.height && w.asset.gait.run === biped.gait.run, 'the leafkin is loaded, with its extras spread on the asset')
  check(w.puppets.length === PUPPETS && w.slots.length === MAX && w.free.length === MAX && w.byKey.size === 0, `${PUPPETS} puppets and ${MAX} slots, none out`)
  check(w.materials.length === PUPPETS * 2 + 1 && w.puppetMats.every((m) => m.plain === w.plain), 'ONE settled material and a fade pair a puppet')
  check(typeof caps.onTake === 'function', 'it listens for her takes on the mushrooms')
  w.dispose()
  check(caps.onTake === null, 'and lets go of them disposed')
  const told = new Caps([])
  told.onTake = () => {}
  const g = new Ground(), e = entrancesOf()
  let threw = 0
  for (const bad of [
    () => new Leafkin(new THREE.Scene(), { walk, entrances: e, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: { cell() {} }, walk, entrances: e, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk: {}, entrances: e, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk, entrances: e, mushrooms: { pickAt() {} }, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk, entrances: e, mushrooms: told, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk, entrances: e, hands: {}, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), { ground: g, walk, entrances: e, asset: { ...makeAsset(), clips: [] } }),
  ]) { try { bad() } catch { threw++ } }
  check(threw === 8, 'no ground, half a ground, a walk surface without heightAt, no entrances, half mushrooms, mushrooms already telling someone, hands without carry() and an asset short of a clip are each refused', `${threw} of 8`)
}

// --- the chapter ------------------------------------------------------------------
console.log('\nthe chapter')
{
  const w = make()
  let t = run(w, START, 1, FAR)
  check(w.byKey.size === 0, `her feet ${FAR.x} m off, it is nobody's to step`)
  const v = make()
  v.update(NEAR, head(NEAR), START + 1 / 60, 1 / 60)
  const d = one(v)
  check(d && d.startTick === tickAfter(START) && d.turnTick === tickAfter(START + CHAPTER_S) && d.homingTick === d.turnTick - HOMING_S * TICK_HZ, `her feet within its roam and cull, it is taken up on its chapter: ${CHAPTER_S} s from the site's own offset, homing ${HOMING_S} s before the turn`)
  check(d && d.tick === d.startTick && Math.hypot(d.x, d.z) >= OUT_M && Math.hypot(d.x, d.z) <= OUT_FAR_M && d.state === 'roam' && d.clip === 'run', `on the chapter's first tick it stands out in its wood, ${OUT_M}-${OUT_FAR_M} m from the mouth, roaming`, d && `${fmt(Math.hypot(d.x, d.z))} m out`)
  check(d && Math.abs(d.size - SIZE_M) <= SIZE_M * SIZE_VAR + 1e-9 && Math.abs(d.k - d.size / biped.height) < 1e-12, `a metre tall, give or take ${SIZE_VAR * 100}%, wearing the scale that makes it so`, d && `${fmt(d.size)} m`)
  v.dispose()
  // Half its wood blocked: every chapter places it on the open half. None open, and the chapter throws rather than stand it in a trunk.
  const half = new Ground()
  half.cell = (x) => (x < 0 ? BLOCKED : OPEN)
  const out = []
  for (let k = 0; k < 20; k++) {
    const h = make({ ground: half })
    h.update(NEAR, head(NEAR), START + k * CHAPTER_S + 1 / 60, 1 / 60)
    out.push(one(h))
    h.dispose()
  }
  check(out.every((o) => o.x >= 0 && Math.hypot(o.x, o.z) >= OUT_M && Math.hypot(o.x, o.z) <= OUT_FAR_M), `over 20 chapters it is only ever placed on open ground, ${OUT_M}-${OUT_FAR_M} m out`, `${out.filter((o) => o.x < 0).length} on the blocked half`)
  const none = new Ground()
  none.cell = () => BLOCKED
  const n = make({ ground: none })
  let threw = null
  try { n.update(NEAR, head(NEAR), START + 1 / 60, 1 / 60) } catch (e) { threw = e.message }
  check(threw?.includes('no open ground'), 'with no open ground about the mouth, the chapter throws', threw ?? 'no throw')
  // Met two minutes in: replayed CATCH_UP_TICKS a frame from the chapter's start, undrawn and unheard, then the same leafkin as one stepped from its start.
  const a = make()
  let ta = meet(a, NEAR, START)
  ta = run(a, ta, 120 - (ta - START), NEAR)
  const b = make()
  let tb = START + 120
  const frames = []
  let drawn = 0, heard = 0
  for (let i = 0; i < 60; i++) {
    b.update(NEAR, head(NEAR), (tb += 1 / 60), 1 / 60)
    const c = one(b)
    frames.push(c.tick)
    if (c.tick === tickOf(tb)) break
    drawn += b.bodies([]).length + (c.lod < LOD_TIERS ? 1 : 0)
    heard += b.voices([]).length
  }
  const steps = Math.ceil((tickOf(tb) - tickAfter(START)) / CATCH_UP_TICKS)
  check(frames.length === steps && frames.slice(0, -1).every((f, i) => f - tickAfter(START) === (i + 1) * CATCH_UP_TICKS), `met ${120} s into its chapter, it is replayed from the start ${CATCH_UP_TICKS} ticks a frame`, `${frames.length} frames`)
  check(drawn === 0 && heard === 0, 'undrawn and silent while it catches up')
  ta = run(a, ta, tb - ta, NEAR)
  check(same(one(a), one(b)), 'and caught up, it is the leafkin one stepped from the start has', `${fmt(one(a).x)},${fmt(one(a).z)} / ${fmt(one(b).x)},${fmt(one(b).z)}`)
  // Let go past its reach and taken up again: replayed back to the same.
  const cull = ROAM_M + cullRange(one(b).size)
  tb = run(b, tb, 1, { x: 0, y: GROUND, z: cull + 30 })
  check(b.byKey.size === 0 && b.free.length === MAX, 'her feet out past its reach and a margin, it is let go')
  tb = meet(b, NEAR, tb)
  ta = run(a, ta, tb - ta, NEAR)
  check(same(one(a), one(b)), 'and back within it, it is taken up where it would have been')
  a.dispose(); b.dispose()
  // Another chapter, another roam; another site, another size.
  const x = make()
  x.update(NEAR, head(NEAR), START + CHAPTER_S + 1 / 60, 1 / 60)
  check(one(x).startTick === d.turnTick && one(x).x !== d.x && one(x).z !== d.z && Math.hypot(one(x).x, one(x).z) >= OUT_M, 'the next chapter is seeded afresh: placed out somewhere else', `${fmt(one(x).x)},${fmt(one(x).z)} / ${fmt(d.x)},${fmt(d.z)}`)
  x.dispose()
  const sizes = new Set()
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const s = make({ entrances: entrancesOf(mouth(key)) })
    s.update(NEAR, head(NEAR), START, 1 / 60)
    sizes.add(one(s).size)
    s.dispose()
  }
  check(sizes.size === 6, 'another site, another size', [...sizes].map(fmt).join(' '))
  w.update(NEAR, head(NEAR), (t += 1 / 60), 1 / 60)
  w.entrances.list.length = 0
  w.update(NEAR, head(NEAR), (t += 1 / 60), 1 / 60)
  check(w.byKey.size === 0 && w.free.length === MAX, 'its site evicted, the slot is back')
  w.dispose()
}

// --- the roam ---------------------------------------------------------------------
console.log('\nthe roam')
{
  const w = make()
  let t = meet(w, NEAR, START)
  const c = one(w)
  let far = 0, legs = 0, straight = 0, path = 0, off = 0, ticks = 0, lastTick = c.tick, lx = c.x, lz = c.z, lh = c.heading, flat = 0, longest = 0, bent = 0
  let tx = c.tx, tz = c.tz, legX = c.x, legZ = c.z
  let minRetarget = Infinity, maxRetarget = 0, legT = t
  const clips = new Set()
  t = run(w, t, 180, NEAR, (c, now) => {
    far = Math.max(far, Math.hypot(c.x, c.z))
    if (c.tick !== lastTick) {
      ticks++
      lastTick = c.tick
      const step = Math.hypot(c.x - lx, c.z - lz)
      path += step
      // A straight run: ticks moving with the heading held to within half the gentlest arc's turn.
      if (step > 0 && Math.abs(swing(lh, c.heading)) < step * ARC_CURVE[0] * 0.5) flat += step; else flat = 0
      longest = Math.max(longest, flat)
      bent += Math.abs(swing(lh, c.heading))
      lx = c.x; lz = c.z; lh = c.heading
      if (Math.abs(swing(c.heading, Math.atan2(-(c.tz - c.z), c.tx - c.x))) > (10 * Math.PI) / 180) off++
    }
    clips.add(c.clip)
    if (c.tx !== tx || c.tz !== tz) {
      legs++
      straight += Math.hypot(c.x - legX, c.z - legZ)
      legX = c.x; legZ = c.z; tx = c.tx; tz = c.tz
      minRetarget = Math.min(minRetarget, now - legT)
      maxRetarget = Math.max(maxRetarget, now - legT)
      legT = now
    }
  })
  check(c.state === 'roam' && far <= ROAM_M + 1, `three minutes of roaming stays inside the ${ROAM_M} m disc`, `out to ${fmt(far)} m`)
  check(legs >= 180 / RETARGET_S[1] - 1 && legs <= 180 / RETARGET_S[0] + 1 && minRetarget >= RETARGET_S[0] - 0.1 && maxRetarget <= RETARGET_S[1] + 0.1, `a new target every ${RETARGET_S[0]}-${RETARGET_S[1]} s`, `${legs} legs, ${fmt(minRetarget)}-${fmt(maxRetarget)} s`)
  check(off / ticks > 0.3 && path > straight * 1.08, 'and it never beelines: the heading is off the bearing more than a third of the time, and the path is longer than its legs', `off ${(100 * off / ticks).toFixed(0)}% of ${ticks} ticks,  ${fmt(path)} m walked over ${fmt(straight)} m of legs`)
  check(longest <= 1, `and no metre of it is straight: every stretch is an arc of ${ARC_M[0]}-${ARC_M[1]} m at ${ARC_CURVE[0]}-${ARC_CURVE[1]} per metre`, `longest straight ${fmt(longest)} m, ${fmt((bent / path) * 180 / Math.PI)}° turned a metre`)
  check(path > 0.9 * biped.gait.run * c.k * 180 * 0.6 && !clips.has('walk') && clips.has('run'), 'at the run, never the walk', `${fmt(path / 180)} m/s of ${fmt(biped.gait.run * c.k)}, clips ${[...clips].join(' ')}`)
  const voices = w.voices([])
  check(voices.length > 0 && w.voices([]).length === 0 && w.pending([]).length === 0, 'its voices wait for the ear, which drains them; and it owes the room nothing', `${voices.length} waiting`)
  w.dispose()
}
{
  const w = make()
  let t = meet(w, NEAR, START)
  const said = []
  t = run(w, t, 120, NEAR, () => w.voices(said))
  const chatter = said.filter((v) => v.sound.startsWith('leafkinChatter'))
  const pants = said.filter((v) => v.sound === 'panting')
  check(said.length >= 120 / CHATTER_S[1] - 1 && said.length <= 120 / CHATTER_S[0] + 1 && chatter.length + pants.length === said.length, `it speaks every ${CHATTER_S[0]}-${CHATTER_S[1]} s roaming, chatter or a pant and nothing else`, `${said.length} in 120 s: ${[...new Set(said.map((v) => v.sound))].sort().join(' ')}`)
  check(said.every((v, i) => (v.sound === 'panting') === (i % 2 === 1)), 'chatter and a pant by turns, the chatter first')
  check(new Set(chatter.map((v) => v.sound)).size >= 3, 'in more than one voice')
  check(chatter.every((v) => Math.abs(v.y - GROUND) < 1 && Math.hypot(v.x, v.z) <= ROAM_M + 1), 'each from where it stands')
  const c = one(w), eye = head(NEAR)
  const d = Math.hypot(c.x - eye.x, GROUND - eye.y, c.z - eye.z)
  check(w.bodies([]).length === (d < cullRange(c.size) ? 1 : 0), `the roam is drawn only inside its ${fmt(cullRange(c.size))} m cull`, `${fmt(d)} m off`)
  w.dispose()
}

// --- the gather ------------------------------------------------------------------
console.log('\nthe gather')
{
  // Seven caps in a bed before it, each within SEEK_M of the last.
  const spots = [[2, 0], [2.4, 0.5], [2.6, -0.5], [3.0, 0.3], [3.3, -0.3], [3.6, 0.6], [3.9, 0]].map(before)
  const hands = handsOf()
  const caps = new Caps(spots)
  const w = make({ spots, mushrooms: caps, hands })
  let t = meet(w, NEAR, START)
  const c = one(w)
  const said = []
  let first = null, full = null
  const squealAt = []
  t = run(w, t, 40, NEAR, (c, now) => {
    for (const v of w.voices([])) { said.push(v); if (v.sound === 'leafkinSqueal') squealAt.push(now) }
    if (c.bundle === 1 && first === null) first = { clip: c.clip, into: c.dur - c.left }
    if (c.bundle === CARRY_MAX && full === null) full = now
  })
  check(first && first.clip === 'gather' && first.into >= GATHER_KEY * w.durations.gather - TICK_S && first.into <= GATHER_KEY * w.durations.gather + 2 * TICK_S, `the first cap is taken at the gather's key, ${GATHER_KEY} of the clip`, first && `${fmt(first.into)} s into the ${fmt(w.durations.gather)} s clip`)
  check(c.bundle === CARRY_MAX && c.carrier?.count() === CARRY_MAX && caps.taken.length === CARRY_MAX && caps.alive.size === spots.length - CARRY_MAX, `the bundle fills at ${CARRY_MAX} and the rest are left standing`, `bundle ${c.bundle}, ${caps.taken.length} taken, ${caps.alive.size} standing`)
  check(c.eaten.length === 2 * CARRY_MAX && w.picks === 0 && w.pending([]).length === 0, 'its own takes are its own, not her picks: nothing owed the room')
  let gap = Infinity
  for (let i = 1; i < squealAt.length; i++) gap = Math.min(gap, squealAt[i] - squealAt[i - 1])
  check(squealAt.length >= 1 && squealAt.length < CARRY_MAX && (squealAt.length === 1 || gap >= SQUEAL_S - TICK_S), `a squeal at a cap in sight, no oftener than SQUEAL_S ${SQUEAL_S} s`, `${squealAt.length} squeals`)
  check(c.state === 'roam' && c.clip === 'run-carry' && Math.abs(c.speed - biped.gait.run * c.k) < 1e-12, 'full, the roam again at the run-carry, which runs at the run', `${c.state} ${c.clip} ${fmt(c.speed)}`)
  const pool = hands.pools.values().next().value
  check(hands.stats.pools === 1 && pool.items.length === CARRY_MAX && hands.loose.length === 0 && POOL_CAP - LOOSE_MAX >= CARRY_MAX * CARRIERS + 3, 'the caps are drawn from the hands\' pool, which holds every carried thing beside the loose and the held')
  const span = c.size * CARRY_SPAN
  check(pool.items.every((i) => i.state === 'carried' && Math.abs(i.rec.size - span) < 1e-9 && i.y > c.pose.y + 0.3 && i.y < c.pose.y + c.size), `carried at its chest, each ${CARRY_SPAN} of the body across`, `${fmt(span)} m of a ${CAP_SPAN} m cap`)
  let apart = Infinity, alike = 0
  for (let i = 0; i < pool.items.length; i++) for (let j = i + 1; j < pool.items.length; j++) {
    const a = pool.items[i], b = pool.items[j]
    apart = Math.min(apart, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
    if (Math.abs(a.q.angleTo(b.q)) < 0.1) alike++
  }
  check(apart > span * 0.5 && alike === 0, 'no two nearer than half a span, and no two within 0.1 rad of one rotation', `${fmt(apart)} m apart, ${alike} alike`)
  w.dispose()
  check(hands.carriers === 0 && pool.items.length === 0, 'the layer disposed, the carrier and its things are gone')
}
{
  // Her hand on the one cap before it gets there: a pick owed the room on the next tick, and the leafkin never goes for it.
  const spots = [before([2, 0])]
  const caps = new Caps(spots)
  const w = make({ spots, mushrooms: caps })
  let t = meet(w, NEAR, START)
  pick(caps, ...spots[0])
  const owed = w.pending([])
  let gathered = false
  t = run(w, t, 10, NEAR, (c) => { if (c.state === 'gather') gathered = true })
  check(owed.length === 1 && owed[0][7] === 'pick' && owed[0][1] === (tickOf(t - 10) + 1) / TICK_HZ && w.picks === 1, 'her pick is owed the room once, on the next tick', JSON.stringify(owed[0]))
  check(!gathered && one(w).bundle === 0 && one(w).eaten.length === 2, 'and the leafkin never goes for the cap she took')
  w.dispose()
}
{
  // A cap in a wall of trunks before it, where its reach never gets: given up on after GIVE_UP_S and never gone for again.
  const spots = [before([2.5, 0])]
  const ground = new Ground(spots)
  ground.walls.push([...before([2.5, -1.5]), ...before([2.5, 1.5])])
  const w = make({ spots, ground, mushrooms: new Caps(spots) })
  let t = meet(w, NEAR, START)
  let gathering = 0, tries = 0, was = null
  t = run(w, t, 30, NEAR, (c) => {
    if (c.state === 'gather') gathering += 1 / 60
    if (c.state === 'gather' && was !== 'gather') tries++
    was = c.state
  })
  const c = one(w)
  check(tries === 1 && gathering <= GIVE_UP_S + 2 * TICK_S && c.bundle === 0 && c.state === 'roam', `a cap it cannot reach is given up on after GIVE_UP_S ${GIVE_UP_S} s and never gone for again`, `${tries} tries, ${fmt(gathering)} s gathering, ${c.state}`)
  w.dispose()
}

// --- the startle and the flight ------------------------------------------------------
console.log('\nthe startle')
{
  const spots = [[2, 0], [2.5, 0.4], [3, -0.4]].map(before)
  const hands = handsOf()
  const caps = new Caps(spots)
  const w = make({ spots, mushrooms: caps, hands })
  let t = meet(w, NEAR, START)
  const c = one(w)
  t = run(w, t, 20, NEAR)
  w.voices([])
  check(c.bundle === 3 && c.state === 'roam', 'three caps in the arms, roaming', `${c.bundle}`)
  // Carried 25 m out, so the run home is long enough to whimper on; her feet a stride off it.
  c.x = c.px = 25; c.z = c.pz = 0
  const at = beside(c)
  const said = []
  const x0 = c.x, z0 = c.z
  const set = t
  let hold = null, screamAt = null, toHer = NaN
  t = run(w, t, 0.2 + LEAD_TICKS * TICK_S, at, (c, now) => { w.voices(said); if (said.length > 0 && screamAt === null) screamAt = now; if (c.state === 'startle' && hold === null) { hold = now; toHer = Math.atan2(-(at.z - c.z), at.x - c.x) } })
  const owed = w.pending([])
  check(screamAt !== null && screamAt - set <= TICK_S + 1 / 60 + 1e-9, 'she hears it scream on the next tick', `${screamAt && fmt(screamAt - set)} s on`)
  check(hold !== null && hold - set <= (LEAD_TICKS + 1) * TICK_S + 1 / 60 + 1e-9 && c.clip === 'recoil' && c.speed === 0, `her feet within ${STARTLE_M} m of its own and ${LEAD_TICKS} ticks on it recoils, the room's lead`, `${hold && fmt(hold - set)} s on`)
  check(owed.length === 1 && owed[0][7] === 'fright' && w.frights === 1, 'a fright owed the room, once', JSON.stringify(owed[0]))
  check(c.bundle === 0 && c.carrier.count() === 0 && hands.loose.length === 3 && hands.loose.every((i) => i.state === 'fall' && !i.mine && i.netId === null), 'the bundle is scattered: exactly the three caps, falling, loose, and nobody\'s to the room', `${hands.loose.length} loose`)
  check(said.length === 1 && said[0].sound === 'leafkinScream', 'with a scream', said.map((v) => v.sound).join(' '))
  let fleeAt = null, faced = NaN
  t = run(w, t, STARTLE_S, at, (c, now) => { w.voices(said); if (c.state === 'flee' && fleeAt === null) { fleeAt = now; faced = c.heading } })
  check(Math.abs(swing(faced, toHer)) < 0.05, 'it has turned to face her by the time it runs', `${fmt(faced)}`)
  check(fleeAt !== null && Math.abs(fleeAt - hold - STARTLE_S) <= TICK_S + 1 / 60 && c.clip === 'run', `${STARTLE_S} s later it runs`, `${fleeAt && fmt(fleeAt - hold)} s`)
  const site = w.entrances.list[0]
  const home = Math.hypot(x0 - site.ax, z0 - site.az)
  const runS = home / (biped.gait.run * c.k)
  let gone = null, farthest = 0, lastSeen = null, goneTick = 0
  said.length = 0
  BOULDER.on = true
  t = run(w, t, runS * 1.5 + 2, at, (c, now) => {
    w.voices(said)
    if (c.state !== 'inside') { farthest = Math.max(farthest, Math.hypot(c.x - x0, c.z - z0)); lastSeen = { ...c.pose } } else if (gone === null) { gone = now; goneTick = c.tick }
  })
  BOULDER.on = false
  check(gone !== null && gone - fleeAt < runS * 1.3 + 0.5 && w.bodies([]).length === 0 && w.byKey.size === 1, `it reaches the arch ${fmt(home)} m off within the run's time and is inside, undrawn, still stepped`, `${gone && fmt(gone - fleeAt)} s of ${fmt(runS)}`)
  check(lastSeen !== null && Math.hypot(lastSeen.x - site.ax, lastSeen.z - site.az) <= HOME_M + biped.gait.run * c.k * TICK_S && lastSeen.y <= GROUND, `last seen within ${HOME_M} m of the arch, on the ground`, lastSeen && `${fmt(Math.hypot(lastSeen.x - site.ax, lastSeen.z - site.az))} m off at y ${fmt(lastSeen.y)}`)
  check(farthest <= home + 0.5, 'straight there', `${fmt(farthest)} m of ${fmt(home)}`)
  const whimpers = said.filter((v) => v.sound === 'leafkinWhimper')
  const pants = said.filter((v) => v.sound === 'panting')
  check(whimpers.length >= 1 && whimpers.length + pants.length === said.length && said.every((v, i) => (v.sound === 'panting') === (i % 2 === 1)), `it speaks every ${WHIMPER_S[0]}-${WHIMPER_S[1]} s on the way, a whimper and a pant by turns`, `${whimpers.length} whimpers, ${pants.length} pants`)
  check(c.until === goneTick + EMPTY_S * TICK_HZ && c.carrier.count() === 0, `inside for ${EMPTY_S} s, its arms empty`)
  let out = null
  t = run(w, t, EMPTY_S + 1, at, (c, now) => { if (out === null && c.state === 'roam') out = { now, tick: c.tick, x: c.px, z: c.pz } }, 20)
  check(out && out.tick === c.until && Math.hypot(out.x, out.z) >= OUT_M && Math.hypot(out.x, out.z) <= OUT_FAR_M, `and ${EMPTY_S} s on, placed out in its wood again`, out && `tick ${out.tick - goneTick}, ${fmt(Math.hypot(out.x, out.z))} m out`)
  w.dispose()
}

// --- the slide round a wall --------------------------------------------------------
console.log('\nthe wall')
for (const [name, walls, x0, feet, clear] of [
  // A wall of trunks across the line home: round it, never through it.
  ['wall', [[10, -6, 10, 6]], 20, { x: 22, y: GROUND, z: 0 }, (c) => Math.abs(c.z) > 6],
  // A pocket open only AWAY from the mouth, a U 6 m deep and 4 m wide: out the wrong way first.
  ['pocket', [[20, -2, 20, 2], [20, -2, 26, -2], [20, 2, 26, 2]], 22, { x: 23, y: GROUND, z: 0 }, (c) => c.x > 26.5],
]) {
  const ground = new Ground()
  ground.walls = walls
  const w = make({ ground })
  let t = meet(w, NEAR, START)
  const c = one(w)
  c.x = c.px = x0; c.z = c.pz = 0
  let gone = null, round = false, through = 0
  t = run(w, t, 60, feet, (c, now) => {
    if (c.state === 'inside') { if (gone === null) gone = now; return }
    if (clear(c)) round = true
    if (inWall(walls, c.x, c.z)) through++
  })
  check(gone !== null && round && through === 0, `out of a ${name} of trunks it gets home, round its end and never through a trunk`, gone ? `${fmt(gone - t + 60)} s, ${through} frames in a trunk` : 'never')
  w.dispose()
}

// --- the turn ------------------------------------------------------------------------
console.log('\nthe turn')
{
  const w = make()
  let t = meet(w, NEAR, START)
  const c = one(w)
  const turnTick = c.turnTick, homingTick = c.homingTick
  let homing = null, inside = null, placed = null
  const said = []
  t = run(w, t, CHAPTER_S - (t - START) + 1, NEAR, (c) => {
    const heard = w.voices([])
    if (c.state === 'home') said.push(...heard)
    if (homing === null && c.state === 'home') homing = c.tick
    if (inside === null && c.state === 'inside' && homing !== null) inside = c.tick
    if (placed === null && c.startTick === turnTick) placed = { tick: c.tick, x: c.x, z: c.z, state: c.state }
  }, 20)
  check(homing === homingTick + 1 || homing === homingTick, `${HOMING_S} s before the turn it makes for home`, `tick ${homing - turnTick}`)
  check(inside !== null && inside < turnTick && w.frights === 0, 'and is inside before the turn', inside && `${fmt((turnTick - inside) / TICK_HZ)} s early`)
  check(said.length > 0 && said.every((v) => v.sound !== 'leafkinWhimper'), 'homing unfrightened, it chatters rather than whimpers', `${said.length} said`)
  check(placed && placed.tick === turnTick && Math.hypot(placed.x, placed.z) >= OUT_M && placed.state === 'roam', 'at the turn it is placed out in its wood on the next chapter\'s first tick')
  w.dispose()
}

// --- drawn within the cull ----------------------------------------------------------
console.log('\nthe puppet')
{
  const w = make()
  const feet = { x: OUT.x - 6, y: GROUND, z: OUT.z + 6 }
  let t = meet(w, feet, START)
  const c = one(w)
  t = run(w, t, 0.5, feet)
  const dist = Math.hypot(c.pose.x - feet.x, c.pose.y - GROUND - 1.6, c.pose.z - feet.z)
  check(c.puppet !== null && c.lod < LOD_TIERS && c.lod === critterTier(c.size, dist, c.lod, LOD_TIERS) && w.bodies([]).length === 1 && w.bodies([])[0] === c.pose, 'near her it wears a puppet on the ladder\'s rung for that distance, and the ear is given its frame pose', `rung ${c.lod} at ${fmt(dist)} m`)
  const b = w.bodies([])[0]
  check(b.clip === c.clip && b.speed === c.speed && b.cycle === w.durations[c.clip] && b.size === c.size, 'with the clip, its cycle, the speed and the size on it')
  check(Math.hypot(c.pose.x - c.x, c.pose.z - c.z) <= c.speed * TICK_S + 1e-9 && c.alpha >= 0 && c.alpha <= 1, 'the frame\'s pose lies between the last two ticks', `alpha ${fmt(c.alpha)}`)
  check(c.puppet.group.matrix.elements[12] === c.pose.x && c.puppet.group.matrix.elements[13] === c.pose.y, 'and the puppet stands on it')
  setTierTint(true)
  t = run(w, t, 0.5, feet)
  const shown = c.puppet.meshes.filter((m) => m.visible)
  check(shown.length === 1 && shown[0].material === TIER_TINTS[c.lod], 'under the critter LOD tint row it wears its rung\'s flat colour like every other creature', `rung ${c.lod}`)
  setTierTint(false)
  t = run(w, t, 0.5, feet)
  check(c.puppet.meshes.filter((m) => m.visible)[0].material === w.plain, 'and its own skin again with the row off')
  w.dispose()
}

// --- two instances agree ---------------------------------------------------------------
console.log('\ntwo instances agree')
{
  const spots = [[2, 0], [3, 1], [6, -2], [20, 5], [21, 4]].map(before)
  const a = make({ spots }), b = make({ spots })
  let ta = meet(a, NEAR, START), tb = START
  while (one(b)?.tick !== tickOf(ta)) b.update(NEAR, head(NEAR), (tb = Math.min(ta, tb + 1 / 30)), 1 / 30)
  const rand = mulberry32(9)
  let compared = 0, same_ = 0
  for (let i = 0; i < 60 * 90; i++) {
    ta += 1 / 60
    a.update(NEAR, head(NEAR), ta, 1 / 60)
    while (tb < ta - 1e-9) {
      const dt = Math.min(ta - tb, 1 / 30 + rand() / 45)
      tb += dt
      b.update(NEAR, head(NEAR), tb, dt)
    }
    if (one(a).tick !== one(b).tick) continue
    compared++
    if (same(one(a), one(b)) && one(a).tx === one(b).tx) same_++
  }
  check(compared > 60 * 80 && same_ === compared, 'stepped on different frame times, two instances hold the same pose, state, clip and bundle on every shared tick, to the bit', `${same_} of ${compared}`)
  check(one(a).bundle >= 2 && one(a).bundle === one(b).bundle, 'and both gathered the same caps', `${one(a).bundle} / ${one(b).bundle}`)
  a.dispose(); b.dispose()
}

// --- the clock skip ------------------------------------------------------------------
console.log('\nthe clock skip')
{
  const w = make(), ref = make()
  let t = meet(w, NEAR, START)
  meet(ref, NEAR, START)
  t = run(w, t, 3, NEAR)
  w.voices([])
  const c = one(w)
  const was = c.tick
  w.update(NEAR, head(NEAR), (t += 10), 1 / 60)
  check(c.tick - was === 200 && c.tick === tickOf(t) && w.voices([]).length === 0, 'a 10 s gap is replayed in one frame, its chatter unsaid', `${c.tick - was} ticks`)
  // +5 h is 300 s on the room's clock: replayed over frames, undrawn and unheard, to where it would have been.
  w.update(NEAR, head(NEAR), (t += 300), 1 / 60)
  let frames = 1, heard = w.voices([]).length
  while (c.tick < tickOf(t)) { w.update(NEAR, head(NEAR), (t += 1 / 60), 1 / 60); frames++; heard += w.voices([]).length }
  run(ref, START, t - START, NEAR, null, 20)
  check(frames === Math.ceil(6000 / CATCH_UP_TICKS) + 1 && heard === 0 && same(c, one(ref)), `a 300 s skip is replayed ${CATCH_UP_TICKS} ticks a frame, silent, to the leafkin one stepped through has`, `${frames} frames, ${heard} heard`)
  // A skip past its chapter: the chapter it lands in, from its start.
  const into = chapterOf(t + 2 * CHAPTER_S, KEY)
  w.update(NEAR, head(NEAR), (t += 2 * CHAPTER_S), 1 / 60)
  check(c.startTick === tickAfter(into.start) && w.voices([]).length === 0, 'a skip past its chapter takes it up in the chapter it lands in, silent')
  w.update(FAR, head(FAR), (t += 1 / 60), 1 / 60)
  check(w.byKey.size === 0 && w.free.length === MAX, `her feet ${FAR.x} m off, it is let go`)
  w.dispose(); ref.dispose()
}

// --- the room ------------------------------------------------------------------------
console.log('\nthe room')
// Two clients on one world and one clock, each's anchors reaching both (its own back too, as the relay sends them) `lag` s later stamped with its id; `late` holds b's for longer.
const pair = ({ spots = [], lag = 0.2, fa = NEAR, fb = { x: 0, y: GROUND, z: -NEAR.z } } = {}) => {
  const A = make({ spots }), B = make({ spots })
  const p = { A, B, fa: { ...fa }, fb: { ...fb }, wire: [], sent: [], late: 0, t: START }
  p.step = (seconds, each = null) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      const t = (p.t += 1 / 60)
      A.update(p.fa, head(p.fa), t, 1 / 60)
      B.update(p.fb, head(p.fb), t, 1 / 60)
      for (const [from, id] of [[A, 'a'], [B, 'b']]) {
        for (const a of from.pending([])) {
          p.sent.push({ t, a: a.slice(), id })
          const stamped = a.slice()
          stamped[8] = id
          for (const to of [A, B]) p.wire.push({ at: t + lag + (id === 'b' && to === A ? p.late : 0), to, a: stamped })
        }
      }
      p.wire = p.wire.filter((m) => (m.at <= t ? (m.to.apply(m.a), false) : true))
      if (each) each(t)
    }
  }
  return p
}
const fits = ({ t, a }) => JSON.stringify(a).length <= 256 && a.length >= 9 && a.length <= 24 && /^[a-z0-9:,-]{1,32}$/.test(a[0]) && a[1] >= t - CHAPTER_S && a[1] <= t + 60 && a.slice(2, 5).every(Number.isFinite) && Number.isInteger(a[6]) && /^[a-z]{1,12}$/.test(a[7]) && a[8] === null
{
  const p = pair()
  let both = 0, apart = 0
  p.step(60, () => { both++; if (!same(one(p.A), one(p.B))) apart++ })
  check(apart === 0 && p.sent.length === 0, 'with neither player near it, both clients step the same leafkin every frame and say nothing to each other', `${both} frames, ${apart} apart, ${p.sent.length} sent`)
  // b's player a stride off it: b startles it at once and tells a, who steps back to before it and agrees again.
  p.fb = beside(one(p.B))
  let bAt = null, aAt = null, apartAfter = 0, after = 0
  p.step(30, (t) => {
    if (bAt === null && one(p.B).state === 'startle') bAt = t
    if (aAt === null && one(p.A).state === 'startle') aAt = t
    if (aAt !== null && t > aAt) { after++; if (!same(one(p.A), one(p.B))) apartAfter++ }
  })
  const fright = p.sent.filter((s) => s.a[7] === 'fright')
  check(bAt !== null && fright.length === 1 && fright[0].id === 'b', 'her feet at b\'s copy startle it there, one fright sent', `${fright.length} sent`)
  check(aAt !== null && aAt - bAt <= 0.2 + 2 / 60 && p.A.rewinds >= 1 && p.B.rewinds === 0, 'a hears it within the lag and steps back to before it', `${aAt && fmt(aAt - bAt)} s later, ${p.A.rewinds} rewinds`)
  check(after > 0 && apartAfter === 0 && one(p.A).state === one(p.B).state, 'and from then the two agree to the bit, its flight home the same on both', `${apartAfter} of ${after} apart, ${one(p.A).state}`)
  check(p.sent.every(fits), 'every anchor fits the relay: 256 bytes of JSON, 9-24 fields, its key, its time within a chapter, a word and an integer where the relay wants them, and no sender', JSON.stringify(p.sent.find((s) => !fits(s))?.a))
  let threw = 0
  for (const a of [['xx:1:2:3', 1, 0, 0, 0, 0, 0, 'fright', null], ['lk:1:2:3', 1, 0, 0, 0, 0, 0, 'dance', null], ['lk:1:2:3', 1, NaN, 0, 0, 0, 0, 'pick', null]]) { try { p.A.apply(a) } catch { threw++ } }
  check(threw === 3, 'an anchor not the leafkin\'s, of no kind or not a number where one is wanted is refused', `${threw} of 3`)
  const r = p.A.rewinds
  const wire = one(p.A).wire
  p.A.apply([`${wire}0:0`, one(p.A).startTick / TICK_HZ, 1, GROUND, 1, 0, 0, 'fright', 'b'])
  p.step(0.1)
  check(p.A.rewinds === r && !p.A.logs.get(wire)?.has(one(p.A).startTick), 'and one on its chapter\'s first tick is let go')
  p.A.dispose(); p.B.dispose()
}
for (const [lag, rewinds] of [[0.1, false], [1.5, true]]) {
  // Her fright is raised LEAD_TICKS ahead: heard sooner than that, a never rolls back; heard 1.5 s late, as off a clock that far out, a's leafkin slides onto its flight.
  const p = pair({ lag })
  p.step(10)
  p.fb = beside(one(p.B))
  p.step(0.5)
  p.fb = { x: 0, y: GROUND, z: -NEAR.z }
  p.step(10)
  const ok = rewinds ? p.A.rewinds > 0 : p.A.rewinds === 0
  check(ok && p.A.jumps === 0 && p.B.jumps === 0 && same(one(p.A), one(p.B)), rewinds ? `heard ${lag} s late it is rolled back and drawn without a jump` : `heard ${lag} s late, inside the ${LEAD_TICKS}-tick lead, it is never rolled back`, `${p.A.rewinds} rewinds of up to ${p.A.maxRewind} ticks, ${p.A.jumps} jumps`)
  p.A.dispose(); p.B.dispose()
}
{
  // b's player picks the cap before it: a hears the pick, and neither goes for it.
  const p = pair({ spots: [before([2, 0])] })
  p.step(1 / 60)
  pick(p.B.mushrooms, ...before([2, 0]))
  let gathered = 0, apart = 0
  p.step(10, (t) => { if (one(p.A).state === 'gather' || one(p.B).state === 'gather') gathered++; if (t > START + 0.5 && !same(one(p.A), one(p.B))) apart++ })
  const picks = p.sent.filter((s) => s.a[7] === 'pick')
  check(picks.length === 1 && picks[0].id === 'b' && fits(picks[0]), 'her pick at b is one anchor, sent', `${picks.length}`)
  check(one(p.A).bundle === 0 && one(p.B).bundle === 0 && p.A.mushrooms.alive.size === 1 && apart === 0, 'and neither copy gathers the cap she took', `${gathered} frames gathering before it was heard, ${apart} apart`)
  p.A.dispose(); p.B.dispose()
}
{
  // A fright heard 40 s late, past every state kept: a replays its chapter and agrees again.
  const p = pair()
  p.step(10)
  p.late = 40
  p.fb = beside(one(p.B))
  p.step(0.2)
  p.fb = { x: 0, y: GROUND, z: -NEAR.z }
  let hidden = 0, apart = 0, heard = null
  p.step(45, (t) => {
    if (heard === null && p.A.rewinds > 0) heard = t
    if (heard !== null && one(p.A).tick < tickOf(t)) hidden++
    else if (heard !== null && !same(one(p.A), one(p.B))) apart++
  })
  check(heard !== null && hidden > 0 && apart === 0 && one(p.A).state === one(p.B).state, 'heard 40 s late, a replays its chapter from the start, hidden meanwhile, and agrees again', `${hidden} frames hidden, ${apart} apart, ${one(p.A).state}`)
  p.A.dispose(); p.B.dispose()
}
{
  // b joins after a's player has startled it: b replays a's fright in its catch-up and meets the leafkin a has.
  const p = pair({ fb: FAR })
  p.step(10)
  p.fa = beside(one(p.A))
  p.step(0.5)
  p.fa = { ...NEAR }
  p.step(20)
  check(p.B.byKey.size === 0 && p.sent.length === 1, 'a startles it before b is near')
  p.fb = { x: 0, y: GROUND, z: -NEAR.z }
  let caught = null, apart = 0
  p.step(5, (t) => { if (caught === null && one(p.B)?.tick === tickOf(t)) caught = t; else if (caught !== null && !same(one(p.A), one(p.B))) apart++ })
  check(caught !== null && apart === 0 && one(p.B).state === one(p.A).state && p.B.rewinds === 0, 'b, joining later, replays the fright and meets the same leafkin a has', `${one(p.A).state} / ${one(p.B).state}, ${apart} apart`)
  p.A.dispose(); p.B.dispose()
}

// --- the real ground --------------------------------------------------------------------
console.log('\nthe real ground')
{
  const { SEED } = await import('../src/v2/config.js')
  const { Heightmap } = await import('../src/v2/height/heightmap.js')
  const { V2Height } = await import('../src/v2/height/field.js')
  const { RELIEF_SHIPPED } = await import('../src/v2/height/relief.js')
  const { Layers } = await import('../src/v2/layers/layers.js')
  const { validate } = await import('../src/v2/layers/doc.js')
  const { BiomeField } = await import('../src/v2/layers/biome.js')
  const { buildRockBank } = await import('../src/props/rock-bank.js')
  const { buildTextureArray } = await import('../src/textures.js')
  const { WaterSurfaces } = await import('../src/v2/render/water-surfaces.js')
  const { Rocks } = await import('../src/v2/render/rocks.js')
  const { Trees } = await import('../src/v2/render/trees.js')
  const { Deadwood, deadwoodBankFrom } = await import('../src/v2/render/deadwood.js')
  const { Mushrooms } = await import('../src/v2/render/mushrooms.js')
  const { Entrances, mouthBankFrom } = await import('../src/v2/render/entrances.js')
  const { readShippedLadder } = await import('./lib/gen-prop-node.mjs')

  const layers = Layers.deserialize(validate(JSON.parse(await readFile('public/world/layers.json', 'utf8'))))
  const field = new V2Height({ heightmap: await Heightmap.read({ path: 'public/world/height.png', metaPath: 'public/world/height.json' }), layers, seed: SEED, relief: RELIEF_SHIPPED })
  const waterS = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field })
  waterS.rebuild()
  const tex = buildTextureArray()
  const S = () => new THREE.Scene()
  const biome = () => new BiomeField({ seed: SEED })
  const deadBank = deadwoodBankFrom({ stump: readShippedLadder('stump-rotting'), log: readShippedLadder('log-fallen', { longAxisZ: true }) })
  const mouthBank = mouthBankFrom(readShippedLadder('cave-mouth'))
  /** One client's world grown about (x, z): its own rocks, dead wood, trees, caps and mouths. */
  const grow = (x, z) => {
    const rocks = new Rocks(S(), field, waterS, layers, tex, { seed: SEED, bank: buildRockBank() })
    rocks.syncBands(layers)
    rocks.place(x, z)
    const deadwood = new Deadwood(S(), field, waterS, layers, { seed: SEED, bank: deadBank, biome: biome() })
    deadwood.place(x, z)
    const trees = new Trees(S(), field, waterS, tex, { seed: SEED, rocks, biome: biome(), deadwood, paths: layers.paths })
    trees.place(x, z)
    const mushrooms = new Mushrooms(S(), field, waterS, layers, tex, [trees, rocks], { seed: SEED })
    mushrooms.syncSnowLine(layers)
    mushrooms.place(x, z)
    const entrances = new Entrances(S(), field, waterS, rocks, { seed: SEED, bank: mouthBank })
    entrances.place(x, z)
    return { rocks, deadwood, trees, mushrooms, entrances, ground: () => new LeafkinGround({ field, water: waterS, trees, rocks, deadwood, mushrooms }) }
  }
  const [cx, cz] = [160, -356]
  const w0 = grow(cx, cz)
  const site = w0.entrances.sites([]).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
  const g = w0.ground()
  let r = 1
  const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296)

  let t0 = performance.now()
  for (let i = 0; i < 20000; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * ROAM_M
    g.cell(site.x + Math.cos(a) * d, site.z + Math.sin(a) * d)
  }
  const scattered = performance.now() - t0
  t0 = performance.now()
  const a0 = g.asked
  for (let x = -30; x < 30; x += CELL) for (let z = -30; z < 30; z += CELL) g.cell(site.x + 40 + x, site.z + z)
  const square = performance.now() - t0, squareCells = g.asked - a0
  t0 = performance.now()
  for (let x = -30; x < 30; x += CELL) for (let z = -30; z < 30; z += CELL) g.cell(site.x + 40 + x, site.z + z)
  const again = performance.now() - t0
  t0 = performance.now()
  for (let i = 0; i < 200; i++) g.capsNear(site.x + rand() * 100 - 50, site.z + rand() * 100 - 50, SEEK_M, [])
  const near = performance.now() - t0
  check(scattered / 20000 < 50e-3 && square / squareCells < 50e-3 && again < square / 5 && near < 50, 'a cell costs microseconds fresh and next to nothing memoized; capsNear is cheap', `20000 scattered ${scattered.toFixed(0)} ms, a 60 m square of ${squareCells} ${square.toFixed(0)} ms then ${again.toFixed(1)} ms, 200 capsNear ${near.toFixed(1)} ms`)

  // Every point a placed blocking rock covers is not open.
  let covered = 0, missed = 0
  const beds = w0.rocks.beds.filter((b) => b.blocks && !b.fitSlope)
  for (let x = -60; x < 60; x += 0.25) for (let z = -60; z < 60; z += 0.25) {
    const px = site.x + x, pz = site.z + z
    if (!beds.some((b) => b._blockAt(px, pz, 0.5, -Infinity, false) > -Infinity)) continue
    covered++
    if (g.cell(px, pz) === OPEN) missed++
  }
  check(covered > 100 && missed === 0, 'its stone is a superset of the placed rocks: no point a blocking rock covers is open', `${covered} points covered, ${missed} open`)

  // Placed trunks and caps about a spot a leafkin roams, grown by a client standing there, against the pure ones.
  const [qx, qz] = g.capsNear(site.x, site.z, ROAM_M, [])
  const w1 = grow(qx, qz)
  const g1 = w1.ground()
  let trunks = 0, trunksBoth = 0
  const TT = 25
  for (let tx = Math.floor((qx - 30) / TT); tx <= Math.floor((qx + 30) / TT); tx++) for (let tz = Math.floor((qz - 30) / TT); tz <= Math.floor((qz + 30) / TT); tz++) {
    const p = w1.trees.pureTrunksInto(tx, tz, [])
    const a = new Float32Array(4 * 400)
    const n = w1.trees.anchorsInto(tx * TT, tz * TT, (tx + 1) * TT, (tz + 1) * TT, a)
    for (let i = 0; i < p.length; i += 3) {
      if (Math.hypot(p[i] - qx, p[i + 1] - qz) > 30) continue
      trunks++
      for (let k = 0; k < n; k++) if (a[k * 4] === p[i] && a[k * 4 + 2] === p[i + 1]) { trunksBoth++; break }
    }
  }
  check(trunks > 20 && trunksBoth === trunks, 'every pure trunk within 30 m of a client is one it placed', `${trunksBoth} of ${trunks}`)
  const pure = g1.capsNear(qx, qz, 20, [])
  let placed = 0, matched = 0
  for (const t of w1.mushrooms.tiles.values()) for (let k = 0; k < t.n; k++) {
    const id = t.ids[k]
    const x = w1.mushrooms.instX[id], z = w1.mushrooms.instZ[id]
    if (Math.hypot(x - qx, z - qz) > 20) continue
    placed++
    for (let n = 0; n < pure.length; n += 2) if (Math.hypot(pure[n] - x, pure[n + 1] - z) < 0.05) { matched++; break }
  }
  check(placed >= 5 && matched / placed >= 0.85, 'and nearly every cap it placed is a pure one: those on rocks are not', `${matched} of ${placed} placed, ${pure.length / 2} pure`)

  // Two clients grown about different spots step the site's leafkin the same: one over a ground the whole disc was asked of, one fresh.
  const make2 = (w, ground) => new Leafkin(S(), { ground, walk: { heightAt: (x, z) => field.heightAndSlopeAt(x, z).h }, entrances: w.entrances, asset: makeAsset() })
  const feet = { x: site.x, y: field.heightAndSlopeAt(site.x, site.z + ROAM_M + 10).h, z: site.z + ROAM_M + 10 }
  const A = make2(w0, g), B = make2(w1, g1)
  const s0 = chapterOf(100000, site.key).start
  // A steps 400 s of the chapter, short of the homing; B, on a fresh ground, joins then and replays them.
  t0 = performance.now()
  let t = run(A, meet(A, feet, s0), 400, feet, null, 20)
  const steppedMs = performance.now() - t0
  t0 = performance.now()
  let joinFrames = 0
  while (B.byKey.get(site.key)?.tick !== tickOf(t)) { B.update(feet, head(feet), t, 0); joinFrames++ }
  const joinMs = performance.now() - t0
  const ca = A.byKey.get(site.key), cb = B.byKey.get(site.key)
  let frames = 0, apart = 0, path = 0
  for (let i = 0; i < 60 * 60; i++) {
    t += 1 / 60
    const x = ca.x, z = ca.z
    A.update(feet, head(feet), t, 1 / 60)
    B.update(feet, head(feet), t, 1 / 60)
    path += Math.hypot(ca.x - x, ca.z - z)
    frames++
    if (!same(ca, cb)) apart++
  }
  check(apart === 0 && path > 30, 'two clients grown about different spots step the site\'s leafkin the same, frame by frame, a minute of its roam after the join', `${apart} of ${frames} apart, ${fmt(path)} m run, ${ca.eaten.length / 2} caps gone`)
  check(joinMs < 1000, 'a join replays 400 s over the real ground in well under a second of frames', `400 s stepped in ${steppedMs.toFixed(0)} ms, replayed cold in ${joinFrames} frames and ${joinMs.toFixed(0)} ms`)
  A.dispose(); B.dispose()
}

console.log(failures ? `\n${failures} FAILED` : '\nall leafkin checks passed')
process.exit(failures ? 1 : 0)
