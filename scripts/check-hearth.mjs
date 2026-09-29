// Node-side gates for a village's gathering place (src/v2/render/hearth.js,
// DESIGN.md §30).
//
//   node scripts/check-hearth.mjs
//
// The hearth is built in memory from the rock bank and a seed, so what is
// gated is that build: that it is deterministic and no two seeds are the same
// place, that the fire ring holds its seven boulders on the rock tile and its
// six logs and five to seven stools on the bark, that every log leans in over
// the fire and every stool stands on its own ground, that the decimated tier
// is a third the triangles and still knows which tile each face wears, that
// the rungs change at 15 and 30 m and come back only under the hysteresis,
// that the ring and every stool are stone to the walker and nothing else is,
// that the wood keeps off the whole place, and that the flame burns at the
// fire's foot in the world.

import * as THREE from 'three'

import { LAYER, buildTextureArray } from '../src/textures.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { HEARTH, Hearth, buildHearth, decimateHearth, feetGround } from '../src/v2/render/hearth.js'
import { SEAT_M } from '../src/v2/render/villagers.js'
import { CAMPFIRE } from '../src/v2/render/fire.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const texArray = buildTextureArray()
const bank = buildRockBank()
// A gentle slope: the clearing's ground is levelled but never quite flat.
const field = { heightAt: (x, z) => 40 + x * 0.03 + Math.sin(z * 0.5) * 0.02 }
const patch = (m) => m

// --- the build --------------------------------------------------------------

{
  const a = buildHearth(bank, 11, () => 0), b = buildHearth(bank, 11, () => 0), c = buildHearth(bank, 12, () => 0)
  const pa = a.geometry.attributes.position.array, pb = b.geometry.attributes.position.array, pc = c.geometry.attributes.position.array
  let same = pa.length === pb.length
  for (let i = 0; same && i < pa.length; i++) same = pa[i] === pb[i]
  check(same, 'the same seed builds the same hearth')
  let differ = pa.length !== pc.length
  for (let i = 0; !differ && i < pa.length; i++) differ = pa[i] !== pc[i]
  check(differ, 'another seed builds another hearth')
  check(a.stools.length >= HEARTH.stools.count[0] && a.stools.length <= HEARTH.stools.count[1], 'five to seven stools', `${a.stools.length}`)
  for (const g of [a, b, c]) g.geometry.dispose()
}

{
  const built = buildHearth(bank, 5, () => 0)
  const g = built.geometry
  const lay = g.attributes.texLayer.array, pos = g.attributes.position.array, col = g.attributes.color.array
  const rockTris = bank.shapes.boulder.tiers[2].attributes.position.count / 3
  let rock = 0, bark = 0, other = 0
  for (let i = 0; i < lay.length; i += 3) {
    if (lay[i] === LAYER.ROCK) rock++
    else if (lay[i] === LAYER.BARK_PINE) bark++
    else other++
  }
  check(rock === HEARTH.ring.count * rockTris, 'seven T20 boulders on the rock tile', `${rock} tris = 7 x ${rockTris}`)
  const logTris = HEARTH.logs.count * (5 * 2 + 3 * 2)
  const stoolTris = built.stools.length * (9 * 2 + 7 * 2)
  check(bark === logTris + stoolTris, 'six pentagon logs and the stools on the bark', `${bark} = ${logTris} + ${stoolTris}`)
  check(other === 0, 'nothing on any other tile', `${other}`)
  check(g.index.count === pos.length / 3, 'the prop layout: every corner its own vertex')

  // The ring's rocks are tinted, the wood is not.
  let tinted = 0, white = 0
  for (let i = 0; i < lay.length; i++) {
    const w = col[i * 3] === 1 && col[i * 3 + 1] === 1 && col[i * 3 + 2] === 1
    if (lay[i] === LAYER.ROCK && !w) tinted++
    if (lay[i] === LAYER.BARK_PINE && w) white++
  }
  check(tinted > 0 && white === bark * 3, 'the rocks carry a tint, the bark none', `${tinted} tinted rock corners`)

  // Every rock sits sunk in the ground and within the ring; the logs reach over the centre; the stools are out on their ring.
  let rockLow = Infinity, rockFar = 0, logHigh = -Infinity, logNear = Infinity
  for (let i = 0; i < lay.length; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], r = Math.hypot(x, z)
    if (lay[i] === LAYER.ROCK) { rockLow = Math.min(rockLow, y); rockFar = Math.max(rockFar, r) }
  }
  // The bark corners come logs first, then the stools: split by count.
  let k = 0
  for (let i = 0; i < lay.length; i++) {
    if (lay[i] !== LAYER.BARK_PINE) continue
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], r = Math.hypot(x, z)
    if (k < logTris * 3) { logHigh = Math.max(logHigh, y); logNear = Math.min(logNear, r) }
    k++
  }
  check(rockLow < -0.02, 'the ring is sunk in the ground', `${rockLow.toFixed(3)} m`)
  check(rockFar < HEARTH.ring.r + HEARTH.ring.size[1], 'the ring holds its radius', `${rockFar.toFixed(2)} m`)
  check(logHigh > HEARTH.logs.rise * 0.9 && logHigh < HEARTH.logs.rise + HEARTH.logs.length * 0.5, 'the logs lean up over the fire', `${logHigh.toFixed(2)} m`)
  check(logNear < HEARTH.logs.tip + HEARTH.logs.radius * 2, 'the logs cross near the centre', `${logNear.toFixed(2)} m`)
  for (const s of built.stools) {
    const r = Math.hypot(s.x, s.z)
    check(r > HEARTH.ring.r + HEARTH.ring.size[1] && r < HEARTH.stools.r + HEARTH.stools.spread + 1e-6, 'a stool sits out on its ring', `${r.toFixed(2)} m`)
  }
  // No two stools overlap.
  let overlap = 0
  for (let i = 0; i < built.stools.length; i++) for (let j = i + 1; j < built.stools.length; j++) {
    const a = built.stools[i], b = built.stools[j]
    if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r) overlap++
  }
  check(overlap === 0, 'no two stools overlap', `${overlap}`)

  // A stool's nonagon is irregular: its corner radii differ.
  const ring9 = []
  k = 0
  for (let i = 0; i < lay.length; i++) {
    if (lay[i] !== LAYER.BARK_PINE) continue
    if (k === logTris * 3) {
      // The first stool's first side's bottom corners.
      const s = built.stools[0]
      ring9.push(Math.hypot(pos[i * 3] - s.x, pos[i * 3 + 2] - s.z), Math.hypot(pos[i * 3 + 3] - s.x, pos[i * 3 + 5] - s.z))
    }
    k++
  }
  check(ring9.length === 2 && Math.abs(ring9[0] - ring9[1]) > 1e-4, 'a stool\'s corners are jittered', ring9.map((r) => r.toFixed(3)).join(' vs '))

  // Every prism faces out: a side away from its own axis, a cap up or down. A jittered top is a fan over corners of differing heights, not a plane, so a cap triangle is judged by the way it faces and not against the centroid. The bark corners come in runs, 48 a log and 96 a stool.
  const nrm = g.attributes.normal.array
  const barkCorners = []
  for (let i = 0; i < lay.length; i++) if (lay[i] === LAYER.BARK_PINE) barkCorners.push(i)
  let inward = 0, prisms = 0
  for (let at = 0; at < barkCorners.length;) {
    const run = prisms < HEARTH.logs.count ? 48 : 96
    const ids = barkCorners.slice(at, at + run)
    const c = [0, 0, 0]
    for (const i of ids) { c[0] += pos[i * 3] / run; c[1] += pos[i * 3 + 1] / run; c[2] += pos[i * 3 + 2] / run }
    // A prism of n corners is 2n sides, then a fan of n - 2 over the foot and another over the top.
    const corners = (run / 3 + 4) / 4
    const mean = (from, to) => {
      const m = [0, 0, 0]
      for (let f = from; f < to; f++) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) m[k] += pos[ids[f * 3 + v] * 3 + k] / ((to - from) * 3)
      return m
    }
    // The prism's own axis, foot to top: a log leans, so neither cap is level.
    const foot = mean(corners * 2, corners * 3 - 2), tip = mean(corners * 3 - 2, corners * 4 - 4)
    const axis = [tip[0] - foot[0], tip[1] - foot[1], tip[2] - foot[2]]
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    for (let f = 0; f * 3 < ids.length; f++) {
      const i = ids[f * 3]
      const m = [0, 1, 2].map((k) => (pos[i * 3 + k] + pos[ids[f * 3 + 1] * 3 + k] + pos[ids[f * 3 + 2] * 3 + k]) / 3 - c[k])
      const n = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]
      const out = f < corners * 2 ? dot(n, m) > 0 : f < corners * 3 - 2 ? dot(n, axis) < 0 : dot(n, axis) > 0
      if (!out) inward++
    }
    at += run
    prisms++
  }
  check(prisms === HEARTH.logs.count + built.stools.length && inward === 0, 'every log and stool faces out', `${inward} inward faces over ${prisms} prisms`)

  // The decimated tier.
  const mid = decimateHearth(g, HEARTH.decimate)
  const full = g.index.count / 3, less = mid.index.count / 3
  check(less <= full * HEARTH.decimate * 1.05 && less >= full * HEARTH.decimate * 0.5, 'the mid tier is a third the triangles', `${less} of ${full}`)
  const ml = mid.attributes.texLayer.array, mc = mid.attributes.color.array
  let midRock = 0, midBark = 0, midOther = 0, midTinted = 0
  for (let i = 0; i < ml.length; i++) {
    if (ml[i] === LAYER.ROCK) { midRock++; if (mc[i * 3] !== 1 || mc[i * 3 + 1] !== 1 || mc[i * 3 + 2] !== 1) midTinted++ }
    else if (ml[i] === LAYER.BARK_PINE) midBark++
    else midOther++
  }
  check(midRock > 0 && midBark > 0 && midOther === 0, 'the mid tier keeps its tiles', `${midRock} rock, ${midBark} bark corners`)
  check(midTinted > 0, 'the mid tier keeps its tints')
  check(mid.attributes.uvProj && mid.attributes.normal, 'the mid tier is in the prop layout')
  mid.dispose()
  g.dispose()
}

// --- the layer --------------------------------------------------------------

{
  const scene = new THREE.Scene()
  const at = { x: 12, z: -7 }
  const h = new Hearth(scene, field, { bank, at, textures: texArray, seed: 3, patch })
  const y = field.heightAt(at.x, at.z)
  check(Math.abs(h.group.position.x - at.x) < 1e-9 && Math.abs(h.group.position.z - at.z) < 1e-9 && Math.abs(h.group.position.y - y) < 1e-9, 'the hearth stands at the clearing\'s centre on its ground')
  check(scene.children.includes(h.group) && scene.children.includes(h.flames.group), 'the mesh and the flame are in the scene')
  const im = h.flames.mesh.instanceMatrix.array
  check(Math.abs(im[12] - at.x) < 1e-4 && Math.abs(im[13] - (y + HEARTH.fire.lift)) < 1e-4 && Math.abs(im[14] - at.z) < 1e-4, 'the flame burns at the fire\'s foot in world space', `${im[12].toFixed(2)}, ${im[13].toFixed(2)}, ${im[14].toFixed(2)}`)
  check(Math.abs(im[5] - CAMPFIRE.height) < 1e-6, 'the flame is the campfire\'s height', `${im[5].toFixed(2)}`)
  {
    // The bench's locked `flicker: 0`: the glow the flame rides is a steady 1 at every instant, not the lamps' breathing.
    const u = h.flames.material.uniforms.uGlow.value
    let steady = true
    for (const t of [0, 0.37, 1.9, 7.25, 100.1]) { h.update(at.x + 3, y + 1.6, at.z, t); if (u.x !== 1 || u.y !== 1 || u.z !== 1) steady = false }
    check(steady, 'the flame burns on a steady glow of 1, the bench\'s flicker 0', `${u.x} ${u.y} ${u.z}`)
  check(h.fire.x === h.x && h.fire.z === h.z && Math.abs(h.fire.y - (h.y + HEARTH.fire.lift)) < 1e-9, 'the fire is reported where the flame burns, for its crackle')
  }
  check(h.material.vertexColors === true, 'the mesh material multiplies the tint')

  // Every stool is cut to its own ground, not the centre's: its base under both its own ground and its sitter's, its top a leafkin's seat over where the feet go (villagers.js SEAT_M).
  const ground = (x, z) => field.heightAt(at.x + x, at.z + z) - h.y
  let onGround = true
  for (const s of h.stools) {
    const feet = feetGround(ground, s.x, s.z, Math.atan2(-s.z, -s.x))
    if (Math.abs(s.top - (feet + SEAT_M)) > 1e-6 || s.y > Math.min(ground(s.x, s.z), feet) + 1e-9) onGround = false
  }
  check(onGround, 'every stool is cut to its own ground, its top a leafkin\'s seat over its sitter\'s feet')

  // The rungs.
  const [mid, far] = HEARTH.lod
  const eye = (d) => h.update(at.x + d, y + 1.6, at.z, 0)
  eye(5); check(h.tier === 0 && h.meshes[0].visible && !h.meshes[1].visible, 'the whole mesh inside 15 m')
  eye(mid + 1); check(h.tier === 1 && !h.meshes[0].visible && h.meshes[1].visible, 'the mid rung past 15 m')
  eye(mid - 0.5); check(h.tier === 1, 'the mid rung holds just inside 15 m')
  eye(mid * HEARTH.hysteresis - 0.5); check(h.tier === 0, 'the whole mesh back under the hysteresis')
  eye(far + 1); check(h.tier === 2 && h.meshes[1].visible && !h.meshes[0].visible, 'the far rung past 30 m draws the mid rung until the card is baked')
  check(h.card === null && h.stats.tris === h.tris[1], 'no card before the bake', `${h.stats.tris} tris`)
  eye(far * HEARTH.hysteresis + 0.5); check(h.tier === 2, 'the far rung holds inside 30 m')
  eye(far * HEARTH.hysteresis - 0.5); check(h.tier === 1, 'the mid rung back under the hysteresis')
  eye(1); check(h.tier === 0, 'the whole mesh up close from the far rung')
  // decimateHearth costs about 200 ms a village entry to save under 300 triangles.
  check(h.tiers[0] === h.tiers[1], 'the mid rung draws the whole mesh, undecimated', `${h.tris.join(' / ')} tris`)

  // Stone to the walker.
  const out = new Float64Array(8)
  let n = h.columnAt(at.x, at.z, 0.5, out)
  check(n === 1 && Math.abs(out[1] - (y + h.ring.top)) < 1e-9 && out[0] < out[1], 'the fire ring is one block at the centre', `top ${out[1].toFixed(2)}`)
  check(Math.abs(h.blockTopAt(at.x, at.z) - (y + h.ring.top)) < 1e-9, 'blockTopAt agrees')
  const s = h.stools[0]
  n = h.columnAt(at.x + s.x, at.z + s.z, 0.5, out)
  check(n === 1 && Math.abs(out[1] - (h.y + s.top)) < 1e-9, 'a stool is a block of its own height', `top ${out[1].toFixed(2)}`)
  check(h.blockTopAt(at.x + s.x, at.z + s.z) === h.y + s.top, 'a stool\'s top is a step')
  n = h.columnAt(at.x + 1.1, at.z, 0.5, out)
  check(n === 0 && h.blockTopAt(at.x + 1.1, at.z) === -Infinity, 'the ground between the ring and the stools is bare')
  n = h.columnAt(at.x + 40, at.z, 0.5, out)
  check(n === 0, 'nothing 40 m out')
  const tiny = new Float64Array(0)
  check(h.columnAt(at.x, at.z, 0.5, tiny) === 0, 'columnAt respects an empty buffer')

  // The wood keeps off.
  check(h.occupiesAt(at.x, at.z, 0) && h.occupiesAt(at.x + 2.2, at.z, 0.3) && !h.occupiesAt(at.x + 4, at.z, 0.5), 'occupiesAt covers the stools and their pad, not the clearing beyond')

  const stats = h.stats
  check(stats.stools === h.stools.length && stats.tier === 0 && stats.card === false, 'stats', JSON.stringify(stats))

  h.dispose()
  check(!scene.children.includes(h.group) && !scene.children.includes(h.flames.group), 'dispose takes the mesh and the flame out')
}

// --- the arguments ----------------------------------------------------------

{
  const scene = new THREE.Scene()
  const throws = (f) => { try { f(); return false } catch { return true } }
  check(throws(() => new Hearth(scene, field, { bank, textures: texArray, patch })), 'no centre throws')
  check(throws(() => new Hearth(scene, field, { at: { x: 0, z: 0 }, textures: texArray, patch })), 'no bank throws')
  check(throws(() => new Hearth(scene, field, { bank, at: { x: 0, z: 0 }, patch })), 'no atlas throws')
  check(throws(() => new Hearth(scene, field, { bank, at: { x: 0, z: 0 }, textures: texArray })), 'no patch throws')
  check(throws(() => new Hearth(scene, {}, { bank, at: { x: 0, z: 0 }, textures: texArray, patch })), 'no ground throws')
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
