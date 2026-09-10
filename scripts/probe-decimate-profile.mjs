// How much of a creature's SILHOUETTE survives decimation?
//
//   node scripts/probe-decimate-profile.mjs [creature-id] [targets...]
//   node scripts/probe-decimate-profile.mjs red-fox 200 100 50
//
// scripts/check-decimate.mjs gates the things that must not change -- UVs, seam
// points, manifoldness. None of that says whether the fox still looks like a
// fox, and at 50 triangles that is the only question left. So this measures the
// outline directly: rasterise the mesh from 32 bearings, compare each mask
// against the same view of the source, and report
//
//   IoU        -- overall agreement, dominated by the torso
//   maxDev     -- the worst gap in either direction, in millimetres of a
//                 creature scaled to 1 m tall, over every view
//
// The second number is the one that matters and the first one is why. A fox's
// ears are ~2% of its silhouette, so lopping them off costs about 0.02 of IoU
// and hides inside the noise -- but it moves maxDev by the whole length of an
// ear. maxDev is symmetric on purpose: shearing the ears off shows up as source
// pixels with no decimated pixel near them, and welding the gap between the ears
// shut shows up as decimated pixels with no source pixel near them, and both are
// the same kind of failure.
//
// Orthographic, one shared frame for every view and every tier, so the numbers
// are comparable across a run and across runs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeMesh, decimateLadder } from '../src/mesh/decimate.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES = 256 // mask resolution; maxDev resolves to ~1/256 of the frame
const AZIMUTHS = 16
const ELEVATIONS = [0, 25]

// --- glb ---------------------------------------------------------------------

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/**
 * The smallest GLB reader that answers this question: positions, texture
 * coordinates and indices of every primitive in the scene, baked through the
 * node hierarchy into one mesh. No materials, no skins, no animation -- the
 * decimator does not read any of them.
 */
function readGlb(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB (bad magic)`)
  let off = 12
  let json = null
  let bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)

  const accessor = (i) => {
    const acc = json.accessors[i]
    const per = COUNTS[acc.type]
    const Ctor = COMPONENT[acc.componentType]
    if (!Ctor || !per) throw new Error(`accessor ${i}: unsupported ${acc.type}/${acc.componentType}`)
    const out = new (acc.componentType === 5126 ? Float32Array : Ctor)(acc.count * per)
    if (acc.bufferView === undefined) return out // spec-legal all-zero accessor
    const view = json.bufferViews[acc.bufferView]
    if (view.buffer !== 0 || !bin) throw new Error(`accessor ${i} points outside the GLB's own binary chunk`)
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const stride = view.byteStride ?? per * Ctor.BYTES_PER_ELEMENT
    for (let e = 0; e < acc.count; e++) {
      const o = base + e * stride
      for (let c = 0; c < per; c++) {
        const at = o + c * Ctor.BYTES_PER_ELEMENT
        out[e * per + c] =
          Ctor === Float32Array ? bin.readFloatLE(at)
          : Ctor === Uint32Array ? bin.readUInt32LE(at)
          : Ctor === Uint16Array ? bin.readUInt16LE(at)
          : Ctor === Int16Array ? bin.readInt16LE(at)
          : Ctor === Int8Array ? bin.readInt8(at)
          : bin.readUInt8(at)
      }
    }
    return out
  }

  const mul = (a, b) => {
    const m = new Float64Array(16)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      m[c * 4 + r] = s
    }
    return m
  }
  const nodeMatrix = (node) => {
    if (node.matrix) return Float64Array.from(node.matrix)
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
    const [sx, sy, sz] = node.scale ?? [1, 1, 1]
    const [tx, ty, tz] = node.translation ?? [0, 0, 0]
    const r = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
    ]
    return Float64Array.from([
      r[0] * sx, r[1] * sx, r[2] * sx, 0,
      r[3] * sy, r[4] * sy, r[5] * sy, 0,
      r[6] * sz, r[7] * sz, r[8] * sz, 0,
      tx, ty, tz, 1,
    ])
  }

  const positions = []
  const uvs = []
  const indices = []
  const walk = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex]
    const world = mul(parent, nodeMatrix(node))
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue // TRIANGLES only
        const pos = accessor(prim.attributes.POSITION)
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null
        const idx = prim.indices !== undefined ? accessor(prim.indices) : null
        const base = positions.length / 3
        for (let i = 0; i < pos.length / 3; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
          positions.push(
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14],
          )
          uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0)
        }
        const n = idx ? idx.length : pos.length / 3
        for (let i = 0; i < n; i++) indices.push(base + (idx ? idx[i] : i))
      }
    }
    for (const child of node.children ?? []) walk(child, world)
  }
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  for (const n of json.scenes[json.scene ?? 0].nodes) walk(n, identity)
  if (!indices.length) throw new Error(`${file} has no triangles`)
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) }
}

// --- silhouettes -------------------------------------------------------------

/** Camera basis for a bearing. `f` points from the camera at the subject. */
function viewBasis(azimuth, elevationDeg) {
  const el = (elevationDeg * Math.PI) / 180
  const eye = [Math.sin(azimuth) * Math.cos(el), Math.sin(el), Math.cos(azimuth) * Math.cos(el)]
  const f = eye.map((v) => -v)
  const rx = -f[2], rz = f[0] // cross(f, worldUp), whose y term is always zero
  const rl = Math.hypot(rx, rz) || 1
  const right = [rx / rl, 0, rz / rl]
  const up = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ]
  return { right, up }
}

/**
 * Fills a RES x RES bitmask with the mesh's outline. The frame is passed in
 * rather than fitted, because a mask fitted to its own mesh would silently
 * rescale a shrunken silhouette back to full size and score it perfect.
 */
function silhouette(mesh, { right, up }, frame) {
  const { centre, half } = frame
  const { positions, indices } = mesh
  const mask = new Uint8Array(RES * RES)
  const px = new Float64Array((positions.length / 3) * 2)
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3] - centre[0], y = positions[i * 3 + 1] - centre[1], z = positions[i * 3 + 2] - centre[2]
    const u = x * right[0] + y * right[1] + z * right[2]
    const v = x * up[0] + y * up[1] + z * up[2]
    px[i * 2] = ((u / half) * 0.5 + 0.5) * RES
    px[i * 2 + 1] = ((v / half) * 0.5 + 0.5) * RES
  }
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3] * 2, b = indices[t * 3 + 1] * 2, c = indices[t * 3 + 2] * 2
    const ax = px[a], ay = px[a + 1], bx = px[b], by = px[b + 1], cx = px[c], cy = px[c + 1]
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-9) continue
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const x1 = Math.min(RES - 1, Math.ceil(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const y1 = Math.min(RES - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5
      for (let x = x0; x <= x1; x++) {
        const sx = x + 0.5
        const w0 = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax)
        const w1 = (cx - bx) * (sy - by) - (cy - by) * (sx - bx)
        const w2 = (ax - cx) * (sy - cy) - (ay - cy) * (sx - cx)
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) mask[y * RES + x] = 1
      }
    }
  }
  return mask
}

/** Chebyshev distance in pixels from every cell to the nearest set cell, by BFS. */
function distanceField(mask) {
  const dist = new Int32Array(RES * RES).fill(-1)
  let frontier = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) { dist[i] = 0; frontier.push(i) }
  let d = 0
  while (frontier.length) {
    const next = []
    d++
    for (const i of frontier) {
      const x = i % RES, y = (i / RES) | 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= RES || ny >= RES) continue
        const j = ny * RES + nx
        if (dist[j] !== -1) continue
        dist[j] = d
        next.push(j)
      }
    }
    frontier = next
  }
  return dist
}

/**
 * IoU and the worst one-sided gap, both directions, over every bearing. `unit`
 * converts pixels to the caller's units.
 */
export function profileError(source, tiers, frame, unit) {
  const views = []
  for (let a = 0; a < AZIMUTHS; a++) for (const el of ELEVATIONS) views.push(viewBasis((a / AZIMUTHS) * Math.PI * 2, el))
  const refs = views.map((v) => {
    const mask = silhouette(source, v, frame)
    return { mask, dist: distanceField(mask) }
  })
  return tiers.map((tier) => {
    let inter = 0, union = 0, lost = 0, gained = 0
    views.forEach((v, i) => {
      const mask = silhouette(tier, v, frame)
      const dist = distanceField(mask)
      const ref = refs[i]
      for (let j = 0; j < mask.length; j++) {
        if (mask[j] && ref.mask[j]) inter++
        if (mask[j] || ref.mask[j]) union++
        if (ref.mask[j] && !mask[j]) lost = Math.max(lost, dist[j]) // source pixel, nothing near it
        if (mask[j] && !ref.mask[j]) gained = Math.max(gained, ref.dist[j])
      }
    })
    return { iou: union ? inter / union : 0, lost: lost * unit, gained: gained * unit, maxDev: Math.max(lost, gained) * unit }
  })
}

/**
 * The silhouette as terminal art, source and tier overlaid: `#` is in both,
 * `-` is source only (lopped off), `+` is tier only (filled in). A number tells
 * you a feature went; this tells you WHICH, and it is the difference between
 * fixing the ears and fixing whatever else was actually wrong.
 */
function overlay(sourceMask, tierMask, cols = 76) {
  const step = RES / cols
  const rows = []
  for (let r = 0; r < cols / 2; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let s = 0, t = 0
      // Sampled by area, and top row first: the mask's +y is up, a terminal's is down.
      for (let y = Math.floor((cols / 2 - 1 - r) * step * 2); y < Math.floor((cols / 2 - r) * step * 2); y++) {
        for (let x = Math.floor(c * step); x < Math.floor((c + 1) * step); x++) {
          s |= sourceMask[y * RES + x]
          t |= tierMask[y * RES + x]
        }
      }
      line += s && t ? '#' : s ? '-' : t ? '+' : ' '
    }
    rows.push(line.replace(/\s+$/, ''))
  }
  return rows.filter((r, i, a) => a.slice(0, i + 1).some((x) => x) && a.slice(i).some((x) => x)).join('\n')
}

// --- run ---------------------------------------------------------------------

const WORK = path.join(ROOT, 'tools/creatures/work')
const [, , idArg = 'red-fox', ...targetArgs] = process.argv
const ids = idArg === 'all'
  ? fs.readdirSync(WORK).filter((d) => fs.existsSync(path.join(WORK, d, 'mesh.glb'))).sort()
  : [idArg]
// Percentages of the source, which is what gen-creature.html's LOD box defaults
// to -- an absolute ladder would mean something different on each creature.
const targetArgsOrDefault = targetArgs.length ? targetArgs : ['50%', '25%', '10%']
const targetsFor = (tris) => targetArgsOrDefault
  .map((t) => Math.max(4, Math.round(t.endsWith('%') ? (tris * Number(t.slice(0, -1))) / 100 : Number(t))))
  .sort((a, b) => b - a)

// WEIGHTS sweeps the feature term; with none given it runs whatever decimate.js
// defaults to, so the plain invocation reports the shipping algorithm.
const weights = process.env.WEIGHTS ? process.env.WEIGHTS.split(',').map(Number) : [undefined]
const modes = (process.env.MODES ?? 'preserve,drop').split(',')
const label = (w) => (w === undefined ? 'dflt' : w.toFixed(2)).padStart(4)

/** Mean of the per-tier scores, and the coarsest tier on its own -- the tier the ladder is judged on. */
const totals = new Map()
const bank = (key, scores) => {
  const t = totals.get(key) ?? { n: 0, iou: 0, dev: 0, coarseIou: 0, coarseDev: 0 }
  for (const s of scores) { t.iou += s.iou; t.dev += s.maxDev; t.n++ }
  const last = scores[scores.length - 1]
  t.coarseIou += last.iou
  t.coarseDev += last.maxDev
  totals.set(key, t)
}

for (const id of ids) {
  const source = readGlb(path.join(WORK, id, 'mesh.glb'))
  const info = analyzeMesh(source)
  const targets = targetsFor(info.tris)

  // One frame for every view and every tier, sized off the source and scaled so
  // the creature is 1 m tall. maxDev then reads as millimetres of a 1 m creature,
  // which is the same number whatever size the glb happened to come back at.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < source.positions.length / 3; i++) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], source.positions[i * 3 + c])
      max[c] = Math.max(max[c], source.positions[i * 3 + c])
    }
  }
  const centre = min.map((v, c) => (v + max[c]) / 2)
  const half = 0.55 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  const frame = { centre, half }
  const unit = ((2 * half) / RES / (max[1] - min[1])) * 1000 // px -> mm of a 1 m-tall creature

  console.log(`\n${id}: ${info.tris} tris, ${info.vertices} verts, ${info.points} welded points, ${info.uvIslands} uv islands  ->  ${targets.join(', ')}`)
  for (const uvMode of modes) {
    console.log(`  uvMode ${uvMode}`)
    if (ids.length === 1) console.log('      fw   target   tris  verts     IoU   lost   gained   maxDev   why')
    for (const featureWeight of weights) {
      const tiers = decimateLadder(source, targets, { uvMode, ...(featureWeight === undefined ? {} : { featureWeight }) })
      const scores = profileError(source, tiers, frame, unit)
      bank(`${uvMode} ${label(featureWeight)}`, scores)
      if (ids.length === 1) {
        tiers.forEach((tier, i) => {
          const s = scores[i]
          console.log(
            `    ${label(featureWeight)}  ${String(targets[i]).padStart(6)}  ${String(tier.stats.outputTris).padStart(5)}` +
            `  ${String(tier.positions.length / 3).padStart(5)}  ${s.iou.toFixed(4)}  ${s.lost.toFixed(1).padStart(5)}` +
            `  ${s.gained.toFixed(1).padStart(6)}  ${s.maxDev.toFixed(1).padStart(6)}mm   ${tier.stats.reason}`,
          )
        })
      } else {
        const last = scores[scores.length - 1]
        console.log(`    ${label(featureWeight)}  coarsest ${String(tiers[tiers.length - 1].stats.outputTris).padStart(5)} tris   IoU ${last.iou.toFixed(4)}   maxDev ${last.maxDev.toFixed(1).padStart(6)}mm`)
      }
      if (process.env.ART) {
        const tier = tiers[tiers.length - 1]
        for (const az of (process.env.ART === '1' ? [0, 90, 180, 270] : process.env.ART.split(',').map(Number))) {
          const v = viewBasis((az * Math.PI) / 180, 0)
          console.log(`\n    ${id}, ${uvMode}, fw ${featureWeight ?? 'dflt'}, ${tier.stats.outputTris} tris, bearing ${az} deg  (# both, - lost, + gained)`)
          console.log(overlay(silhouette(source, v, frame), silhouette(tier, v, frame)))
        }
      }
    }
  }
}

if (ids.length > 1) {
  console.log(`\nmean over ${ids.length} creatures`)
  console.log('    mode        fw    all tiers            coarsest tier')
  for (const [key, t] of totals) {
    console.log(
      `    ${key.padEnd(13)}  IoU ${(t.iou / t.n).toFixed(4)}  ${(t.dev / t.n).toFixed(1).padStart(6)}mm` +
      `     IoU ${(t.coarseIou / ids.length).toFixed(4)}  ${(t.coarseDev / ids.length).toFixed(1).padStart(6)}mm`,
    )
  }
}
