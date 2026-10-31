// Builds one castle off the main thread (design/44-castles.md, Tiers): its layout, the full and mid-distance exteriors, the court,
// the interior and dungeon as one mesh, the dungeon's water and door, its collision and portals, and its props' flames. Replies
// { id, seed, full, low, court, interior, water (or null), door, solids, flames: { exterior, interior } }, or { id, seed, error }.
// Posts { ready: true } once loaded: Chrome can deliver a job while the imports still evaluate, to a null onmessage, which drops it
// without a sound and leaves the castle on its card. The main thread holds its jobs until then.
import { castleLayout } from './layout.js'
import { courtGeometry, exteriorGeometry, interiorGeometries, interiorWarp, warpedProp } from './shell.js'
import { courtProps, dungeonProps, propFlames, roofProps, roomProps } from './furnish.js'
import { dungeonGeometry } from './dungeon-mesh.js'
import { castleSolids } from './solids.js'
import { courtGlow } from './glow.js'

/** Storey meshes as one, its groups per material slot spanning every storey. */
function mergeStoreys(list) {
  const slots = list[0].groups.length, parts = []
  for (let s = 0; s < slots; s++) for (const d of list) {
    const [start, count] = d.groups[s]
    parts.push({ d, start, count, slot: s })
  }
  const total = parts.reduce((a, p) => a + p.count, 0)
  const out = { position: new Float32Array(total * 3), normal: new Float32Array(total * 3), color: new Float32Array(total * 3), uv: new Float32Array(total * 2), light: new Float32Array(total * 3), groups: [] }
  let at = 0
  for (let s = 0; s < slots; s++) {
    const g0 = at
    for (const p of parts) {
      if (p.slot !== s) continue
      for (const [k, w] of [['position', 3], ['normal', 3], ['color', 3], ['uv', 2], ['light', 3]]) out[k].set(p.d[k].subarray(p.start * w, (p.start + p.count) * w), at * w)
      at += p.count
    }
    out.groups.push([g0, at - g0, s])
  }
  return out
}

const buffers = (d) => [d.position.buffer, d.normal.buffer, d.color.buffer, d.uv.buffer, ...(d.light ? [d.light.buffer] : [])]

self.onmessage = (ev) => {
  const { id, seed } = ev.data
  let reply
  try {
    const lay = castleLayout(seed)
    if (!lay.stats.ok) throw new Error(`castle worker: seed ${seed} has no good layout`)
    const solids = castleSolids(lay), glow = courtGlow(lay, solids)
    const full = exteriorGeometry(lay, { glow }), low = exteriorGeometry(lay, { full: false, glow }), court = courtGeometry(lay, glow)
    const dungeon = dungeonGeometry(lay)
    const interior = mergeStoreys([dungeon.geometry, ...interiorGeometries(lay).map((s) => s.geometry)]), { door, water } = dungeon
    const warp = interiorWarp(lay), inner = [...roomProps(lay), ...dungeonProps(lay)].map((o) => warpedProp(warp, o))
    const flames = { exterior: new Float32Array(propFlames([...courtProps(lay), ...roofProps(lay)])), interior: new Float32Array(propFlames(inner)) }
    reply = { id, seed, full, low, court, interior, water, door, solids, flames }
  } catch (e) {
    self.postMessage({ id, seed, error: e.stack ?? e.message })
    return
  }
  self.postMessage(reply, [...[reply.full, reply.low, reply.court, reply.interior, reply.door, ...(reply.water ? [reply.water] : [])].flatMap(buffers), reply.flames.exterior.buffer, reply.flames.interior.buffer])
}
self.postMessage({ ready: true })
