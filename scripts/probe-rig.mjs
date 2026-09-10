// What is in a rigged glb, and does the animation actually move it?
//
//   node scripts/probe-rig.mjs red-fox            # rig.glb in that creature's work dir
//   node scripts/probe-rig.mjs red-fox anim-preset-quadruped-walk.glb
//   node scripts/probe-rig.mjs path/to/any.glb
//
// A rigged mesh has two independent things that can be wrong and one triangle
// count cannot tell them apart:
//
//   1. the SHAPE of the skeleton -- where the joints sit and what parents what
//   2. the NAMES on it -- which Tripo assigns from its own guess at anatomy
//
// Retargeting a preset clip is done by name, so a correct skeleton with wrong
// names animates like a broken one. This probe prints both, side by side: the
// name each joint carries, and where that joint actually is on the animal. A
// chain called Limb whose tip is at the top of the head is the whole bug, and it
// is invisible in a viewport that draws bones as identical white sticks.
//
// With an animation it also prints, per bone, how far the clip moves it from its
// rest pose and how much it swings over the clip -- and, loudly, every bone the
// clip never touches, because a preset that silently drives six bones out of
// thirty-five is a paid no-op.

import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

const COMPONENT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] }
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function readGlb(file) {
  const buf = readFileSync(file)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x46546C67) throw new Error(`${file} is not a glb`)
  let off = 12, json = null, bin = null
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body))
    if (type === 0x004E4942) bin = body
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)
  return { json, bin }
}

/** One accessor as an array of rows, honouring byteStride. */
function accessor(g, bin, index) {
  const a = g.accessors[index]
  const n = COMPONENTS[a.type]
  const [Arr, bytes] = COMPONENT[a.componentType]
  const view = g.bufferViews[a.bufferView]
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const stride = view.byteStride ?? n * bytes
  const rows = []
  for (let i = 0; i < a.count; i++) {
    const row = new Arr(bin.buffer.slice(bin.byteOffset + base + i * stride, bin.byteOffset + base + i * stride + n * bytes))
    rows.push([...row])
  }
  return rows
}

// --- transforms -------------------------------------------------------------
//
// Column-major 3x4: nine rotation/scale terms then the translation, which is all
// a joint hierarchy needs (no projection, no shear).

function trs(t, q, s) {
  const [x, y, z, w] = q
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0],
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1],
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2],
    t[0], t[1], t[2],
  ]
}

function mul(a, b) {
  const o = new Array(12)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2] + (c === 3 ? a[9 + r] : 0)
    }
  }
  return o
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

/** Angle between two quaternions, in degrees. */
const between = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI

// --- the rig ----------------------------------------------------------------

function rigOf(g, bin) {
  const parent = new Map()
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
  const roots = g.nodes.map((_, i) => i).filter((i) => !parent.has(i))
  const anim = g.animations?.[0] ?? null
  const sampler = new Map() // `${node}:${path}` -> sampled rows
  let times = [0]
  if (anim) {
    times = accessor(g, bin, anim.samplers[0].input).map((r) => r[0])
    for (const c of anim.channels) sampler.set(`${c.target.node}:${c.target.path}`, accessor(g, bin, anim.samplers[c.sampler].output))
  }
  const local = (i, frame) => {
    const n = g.nodes[i]
    const pick = (path, rest) => {
      const rows = sampler.get(`${i}:${path}`)
      return frame === null || !rows ? rest : rows[Math.min(frame, rows.length - 1)]
    }
    return trs(pick('translation', n.translation ?? [0, 0, 0]), pick('rotation', n.rotation ?? [0, 0, 0, 1]), pick('scale', n.scale ?? [1, 1, 1]))
  }
  /** World position of every node at a frame, or at the rest pose when frame is null. */
  const world = (frame) => {
    const out = new Map()
    const walk = (i, m) => {
      const wm = mul(m, local(i, frame))
      out.set(i, [wm[9], wm[10], wm[11]])
      ;(g.nodes[i].children ?? []).forEach((c) => walk(c, wm))
    }
    for (const r of roots) walk(r, IDENTITY)
    return out
  }
  return { parent, roots, anim, sampler, times, world }
}

/**
 * What each joint IS, read off the geometry rather than off its name.
 *
 * A joint's name is Tripo's guess; its position is a fact. Chains are walked to
 * their tips, and a tip is called a foot when it sits in the bottom fifth of the
 * mesh -- that is what a foot does, whatever the bone is called. Front and back
 * split on the body's long horizontal axis, taken from the spread of the joints
 * themselves, with the head end being the end the highest non-foot tip is at.
 */
function anatomy(g, rest, bbox) {
  const joints = [...rest.keys()].filter((i) => g.nodes[i].mesh === undefined)
  const lo = bbox.min[1], hi = bbox.max[1]
  const groundLine = lo + (hi - lo) * 0.2

  // The body's long horizontal axis, from the spread of the joints themselves
  // (the 2x2 covariance of X and Z). Not X or Z alone: a creature imported at
  // any yaw lies along a diagonal, and the fox lies along one.
  const mean = [0, 2].map((k) => joints.reduce((s, i) => s + rest.get(i)[k], 0) / joints.length)
  let cxx = 0, cxz = 0, czz = 0
  for (const i of joints) {
    const dx = rest.get(i)[0] - mean[0], dz = rest.get(i)[2] - mean[1]
    cxx += dx * dx; cxz += dx * dz; czz += dz * dz
  }
  const theta = 0.5 * Math.atan2(2 * cxz, cxx - czz)
  let ax = Math.cos(theta), az = Math.sin(theta)
  const along = (i) => (rest.get(i)[0] - mean[0]) * ax + (rest.get(i)[2] - mean[1]) * az

  const parentOf = new Map()
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)))
  // Every chain hangs off the last joint that branched. Measuring a chain from
  // there is what separates a leg from a tail: both end low, but a leg drops
  // further than it travels sideways and a tail does the opposite.
  const branch = (i) => {
    let at = parentOf.get(i)
    while (at !== undefined && (g.nodes[at].children ?? []).filter((c) => rest.has(c)).length < 2 && parentOf.has(at)) at = parentOf.get(at)
    return at ?? i
  }

  const tips = joints.filter((i) => !(g.nodes[i].children ?? []).some((c) => rest.has(c)))
  const feet = [], free = []
  for (const t of tips) {
    const root = rest.get(branch(t)), p = rest.get(t)
    const drop = root[1] - p[1]
    const travel = Math.hypot(p[0] - root[0], p[2] - root[2])
    ;(p[1] <= groundLine && drop > travel ? feet : free).push(t)
  }
  const head = free.length ? free.reduce((a, b) => (rest.get(a)[1] > rest.get(b)[1] ? a : b)) : null
  // The head end fixes which way is forward, so "front" means the end the head
  // is at whatever direction the creature was authored facing.
  if (head !== null && along(head) < 0) { ax = -ax; az = -az }

  const label = new Map()
  if (head !== null) label.set(head, 'head tip')
  const tail = free.filter((t) => t !== head).sort((a, b) => along(a) - along(b))[0]
  for (const f of free) {
    if (f === head) continue
    label.set(f, f === tail ? 'tail tip' : 'free tip')
  }
  // Front and hind split at the widest gap along the body rather than at its
  // midpoint: the feet come in two clusters and the gap between them is the
  // animal's own answer to where its shoulders end and its hips begin.
  const order = [...feet].sort((a, b) => along(a) - along(b))
  let cut = 0, widest = -Infinity
  for (let i = 1; i < order.length; i++) {
    const gap = along(order[i]) - along(order[i - 1])
    if (gap > widest) { widest = gap; cut = i }
  }
  order.forEach((f, i) => label.set(f, `${i >= cut ? 'front' : 'hind'} foot`))
  return { label, axis: [ax, az], feet, free, head, groundLine }
}

// --- run --------------------------------------------------------------------

const arg = process.argv[2]
if (!arg) {
  console.error('usage: node scripts/probe-rig.mjs <creature-id|path.glb> [file.glb]\n')
  process.exit(1)
}
const dir = `tools/creatures/work/${arg}`
const file = arg.endsWith('.glb') ? arg : `${dir}/${process.argv[3] ?? 'rig.glb'}`
if (!existsSync(file)) throw new Error(`no such file: ${file}`)

const { json: g, bin } = readGlb(file)
const rig = rigOf(g, bin)
const rest = rig.world(null)

const meshNode = g.nodes.find((n) => n.mesh !== undefined)
const posAccessor = meshNode ? g.accessors[g.meshes[meshNode.mesh].primitives[0].attributes.POSITION] : null
if (!posAccessor?.min) throw new Error('the skinned mesh accessor has no min/max, so nothing can be measured against the body')
const bbox = { min: posAccessor.min, max: posAccessor.max }
const skin = g.skins?.[0]

console.log(`\n${basename(file)}`)
console.log(`  ${g.nodes.length} nodes, ${skin ? `${skin.joints.length} joints` : 'no skin'}, ${g.animations?.length ?? 0} animations`)
console.log(`  mesh bounds  x ${bbox.min[0].toFixed(3)}..${bbox.max[0].toFixed(3)}   y ${bbox.min[1].toFixed(3)}..${bbox.max[1].toFixed(3)}   z ${bbox.min[2].toFixed(3)}..${bbox.max[2].toFixed(3)}`)

const { label, axis, groundLine } = anatomy(g, rest, bbox)
console.log(`  faces (${axis[0].toFixed(2)}, 0, ${axis[1].toFixed(2)}); anything below y ${groundLine.toFixed(3)} is standing on the ground`)

// Per-bone motion, if this file carries a clip.
const motion = new Map()
if (rig.anim) {
  for (let i = 0; i < g.nodes.length; i++) {
    const rows = rig.sampler.get(`${i}:rotation`)
    if (!rows) continue
    const restQ = g.nodes[i].rotation ?? [0, 0, 0, 1]
    let offset = Infinity, swing = 0
    for (const q of rows) {
      offset = Math.min(offset, between(restQ, q))
      for (const p of rows) swing = Math.max(swing, between(p, q))
    }
    motion.set(i, { offset, swing })
  }
}

console.log('\nthe skeleton -- name, where that joint actually is, what the clip does to it')
const line = (i, depth) => {
  const n = g.nodes[i]
  if (n.mesh !== undefined && !(n.children ?? []).length) return
  const p = rest.get(i)
  const m = motion.get(i)
  const drive = rig.anim
    ? (m ? `${m.offset >= 5 ? `bent ${m.offset.toFixed(0)}deg off rest, ` : ''}swings ${m.swing.toFixed(0)}deg` : 'NOT ANIMATED')
    : ''
  const where = label.get(i) ? `  <- ${label.get(i)}` : ''
  console.log(
    `  ${('  '.repeat(depth) + (n.name ?? `node ${i}`)).padEnd(34)}` +
    ` x${p[0].toFixed(3).padStart(7)} y${p[1].toFixed(3).padStart(7)} z${p[2].toFixed(3).padStart(7)}` +
    `  ${drive.padEnd(30)}${where}`)
  ;(n.children ?? []).forEach((c) => line(c, depth + 1))
}
for (const r of rig.roots) line(r, 0)

if (rig.anim) {
  const named = [...rig.sampler.keys()].filter((k) => k.endsWith(':rotation')).map((k) => Number(k.split(':')[0]))
  const still = named.filter((i) => (motion.get(i)?.swing ?? 0) < 1)
  const bent = named.filter((i) => (motion.get(i)?.offset ?? 0) >= 30)
  console.log(`\nclip "${rig.anim.name ?? '(unnamed)'}" -- ${rig.times.length} keys over ${rig.times[rig.times.length - 1].toFixed(2)}s`)
  console.log(`  ${named.length - still.length} of ${named.length} animated bones actually move`)
  if (still.length) console.log(`  frozen: ${still.map((i) => g.nodes[i].name ?? i).join(', ')}`)
  if (bent.length) {
    console.log(`  held off their rest pose by 30deg or more: ${bent.map((i) => `${g.nodes[i].name ?? i} (${motion.get(i).offset.toFixed(0)}deg)`).join(', ')}`)
    console.log('  A large constant offset is a retarget forcing this skeleton into the reference creature\'s pose, not a gait.')
  }
  // Feet that end up under the floor are the loudest single symptom, and the one
  // that survives being looked at from a bad camera angle.
  const floor = bbox.min[1]
  const sunk = []
  for (let f = 0; f < rig.times.length; f++) {
    const w = rig.world(f)
    for (const [i, what] of label) {
      if (!what.endsWith('foot')) continue
      const y = w.get(i)[1]
      if (y < floor - (bbox.max[1] - floor) * 0.02) sunk.push([g.nodes[i].name ?? i, y])
    }
  }
  if (sunk.length) {
    const worst = new Map()
    for (const [name, y] of sunk) worst.set(name, Math.min(worst.get(name) ?? Infinity, y))
    console.log(`  feet driven below the ground plane: ${[...worst].map(([n, y]) => `${n} (${(y - floor).toFixed(3)}m)`).join(', ')}`)
  }
}
console.log()
