// Builds one castle off the main thread (design/44-castles.md, Tiers): its layout, the full and mid-distance exteriors, the court,
// the interior as one mesh, and its collision and portals. Replies { id, seed, full, low, court, interior, solids }, or { id, seed,
// error } when it throws.
import { castleLayout } from './layout.js'
import { courtGeometry, exteriorGeometry, interiorGeometries } from './shell.js'
import { castleSolids } from './solids.js'

// The interior is drawn unlit (render/castles.js): each face's colour is shaded here by which way it faces.
const SHADE = { top: 1, side: [0.8, 0.7], under: 0.55, all: 0.85 }

function shadeInterior(d) {
  const { normal: n, color: c } = d
  for (let i = 0; i < n.length; i += 3) {
    const f = SHADE.all * (n[i + 1] > 0.7 ? SHADE.top : n[i + 1] < -0.7 ? SHADE.under : Math.abs(n[i]) > Math.abs(n[i + 2]) ? SHADE.side[0] : SHADE.side[1])
    c[i] *= f; c[i + 1] *= f; c[i + 2] *= f
  }
  return d
}

/** Storey meshes as one, its groups per material slot spanning every storey. */
function mergeStoreys(list) {
  const slots = list[0].groups.length, parts = []
  for (let s = 0; s < slots; s++) for (const d of list) {
    const [start, count] = d.groups[s]
    parts.push({ d, start, count, slot: s })
  }
  const total = parts.reduce((a, p) => a + p.count, 0)
  const out = { position: new Float32Array(total * 3), normal: new Float32Array(total * 3), color: new Float32Array(total * 3), uv: new Float32Array(total * 2), groups: [] }
  let at = 0
  for (let s = 0; s < slots; s++) {
    const g0 = at
    for (const p of parts) {
      if (p.slot !== s) continue
      for (const [k, w] of [['position', 3], ['normal', 3], ['color', 3], ['uv', 2]]) out[k].set(p.d[k].subarray(p.start * w, (p.start + p.count) * w), at * w)
      at += p.count
    }
    out.groups.push([g0, at - g0, s])
  }
  return out
}

const buffers = (d) => [d.position.buffer, d.normal.buffer, d.color.buffer, d.uv.buffer]

self.onmessage = (ev) => {
  const { id, seed } = ev.data
  let reply
  try {
    const lay = castleLayout(seed)
    if (!lay.stats.ok) throw new Error(`castle worker: seed ${seed} has no good layout`)
    const full = exteriorGeometry(lay), low = exteriorGeometry(lay, { full: false }), court = courtGeometry(lay)
    const interior = shadeInterior(mergeStoreys(interiorGeometries(lay).map((s) => s.geometry)))
    reply = { id, seed, full, low, court, interior, solids: castleSolids(lay) }
  } catch (e) {
    self.postMessage({ id, seed, error: e.stack ?? e.message })
    return
  }
  self.postMessage(reply, [reply.full, reply.low, reply.court, reply.interior].flatMap(buffers))
}
