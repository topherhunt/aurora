/**
 * Bake the shore crab's clips into one animation texture: public/creatures/shore-crab-anim.bin.
 *
 *   node tools/creatures/ship-crab.mjs
 *
 * Design §27, "The crab". The clips are specs in anim/clips/crab/*.json, evaluated here on the rig of
 * rig-crab.mjs -- not solved by the anim pipeline, which fits clips to a Tripo rig. A frame is one row of the
 * texture: each bone's rigid delta from the bind pose, a 3x4 matrix in three half-float RGBA texels.
 *
 * File: u32 header length, the header JSON (padded to 4 bytes), then the half-float texels.
 * `{ bones, cycle, clips: [{ name, kind, base, frames, seconds }], tiers: [[bone of each vertex] ...] }`.
 * `cycle` is the distance in mesh units one walk cycle covers.
 *
 * Spec tracks are periodic over t in [0, 1) with smoothstep between keys: `root` (rx ry rz degrees, dy),
 * `fk` (rx ry rz degrees about the bone's joint; `open` degrees swings a claw finger down), `ik` (a foot offset
 * dx dy dz for a leg, solved with a two-bone IK that bends the knee up). A `gait` adds the walk's feet.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELF_BAKED } from './anim/build.mjs'
import { loadTiers } from './rig-crab.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIPS = path.join(HERE, 'anim/clips/crab')
export const OUT = path.join(HERE, '../../public/creatures/shore-crab-anim.bin')

/** A foot offset shorter than this is blended in from the bind pose, so a two-bone solve never snaps a straight leg. */
const IK_RAMP = 0.02

// --- small matrices: 4x4 row-major in a 16-array ----------------------------

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a, b) {
  const o = new Array(16).fill(0)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]
  return o
}
const rotAbout = (R, p) => {
  // T(p) R T(-p): R is 3x3 row-major
  const o = I4()
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = R[r * 3 + c]
    o[r * 4 + 3] = p[r] - (R[r * 3] * p[0] + R[r * 3 + 1] * p[1] + R[r * 3 + 2] * p[2])
  }
  return o
}
const translate = (t) => { const o = I4(); o[3] = t[0]; o[7] = t[1]; o[11] = t[2]; return o }
const eulerDeg = (rx, ry, rz) => {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180)
  const [sa, ca, sb, cb, sc, cc] = [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b), Math.sin(c), Math.cos(c)]
  // Rz * Ry * Rx
  return [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa, sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa, -sb, cb * sa, cb * ca]
}
const axisAngle = (ax, ang) => {
  const [x, y, z] = ax, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]
}
const mulV3 = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]]
const mulM3 = (A, B) => { const o = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]; return o }
const tr3 = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => scale(a, 1 / len(a))
/** The rotation taking direction a to direction b by the shortest arc. */
function arc(a, b) {
  const ua = unit(a), ub = unit(b), ax = cross(ua, ub), s = len(ax)
  if (s < 1e-9) return axisAngle([0, 1, 0], 0)
  return axisAngle(scale(ax, 1 / s), Math.atan2(s, dot(ua, ub)))
}
const IDENTITY3 = axisAngle([0, 1, 0], 0)

// --- tracks ------------------------------------------------------------------

const smooth = (u) => u * u * (3 - 2 * u)
/** A periodic track's value at t in [0, 1): smoothstep between its keys, the last wrapping to the first. */
function sample(keys, t) {
  if (!keys) return 0
  const n = keys.length
  for (let i = 0; i < n; i++) {
    const [t0, v0] = keys[i]
    const [t1, v1] = i + 1 < n ? keys[i + 1] : [keys[0][0] + 1, keys[0][1]]
    const tt = t < keys[0][0] ? t + 1 : t
    if (tt >= t0 && tt < t1) return v0 + (v1 - v0) * smooth((tt - t0) / (t1 - t0))
  }
  throw new Error(`track has no segment at t=${t}`)
}

// --- the clip evaluator --------------------------------------------------------

function legsOf(rig) {
  const legs = new Map()
  rig.bones.forEach((b, i) => {
    const m = /^Leg(\d)Upper\.([RL])$/.exec(b.name)
    if (m) legs.set(`Leg${m[1]}.${m[2]}`, { upper: i, lower: i + 1, n: Number(m[1]), tag: m[2] })
  })
  return legs
}

/** Rotations (upper, lower) that put a leg's foot `off` from its bind spot, the knee bending up. */
function solveLeg(rig, leg, off) {
  const R = rig.bones[leg.upper].at, K = rig.bones[leg.upper].tip, F = rig.bones[leg.lower].tip
  const l1 = len(sub(K, R)), l2 = len(sub(F, K))
  const want = add(F, off)
  const d = sub(want, R)
  const D = Math.min(Math.max(len(d), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
  const u = unit(d)
  let p = [0, 1, 0]
  p = unit(sub(p, scale(u, dot(p, u))))
  const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D), h = Math.sqrt(Math.max(l1 * l1 - a * a, 0))
  const K2 = add(R, add(scale(u, a), scale(p, h)))
  const F2 = add(R, scale(u, D))
  const Ru = arc(sub(K, R), sub(K2, R))
  const Q = arc(mulV3(Ru, sub(F, K)), sub(F2, K2))
  const Rl = mulM3(tr3(Ru), mulM3(Q, Ru))
  return { Ru, Rl }
}

/** Slerp-free blend of a rotation toward identity: the angle scaled by s. */
function ease(R, s) {
  const cosA = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2))
  const ang = Math.acos(cosA)
  if (ang < 1e-9) return R
  const ax = unit([R[7] - R[5], R[2] - R[6], R[3] - R[1]])
  return axisAngle(ax, ang * s)
}

/** The finger's hinge axis, signed so a positive `open` swings its tip down. */
function fingerAxis(rig, i) {
  const { at, tip } = rig.bones[i]
  const ax = unit(cross(sub(tip, at), [0, 1, 0]))
  const probe = mulV3(axisAngle(ax, 0.1), sub(tip, at))
  return probe[1] < tip[1] - at[1] ? ax : scale(ax, -1)
}

/** Every bone's 4x4 delta from bind for clip `spec` at cycle position t in [0, 1). */
export function evalClip(spec, rig, t) {
  const legs = legsOf(rig)
  const feet = new Map([...legs.keys()].map((k) => [k, [0, 0, 0]]))
  const g = spec.gait
  const stride = g ? g.stride : 0
  if (g) {
    for (const [name, leg] of legs) {
      const ph = g.phase[leg.tag][leg.n]
      const c = (((t + ph) % 1) + 1) % 1
      // The crab travels +Z. Stance carries a foot back along Z by `stride` (a +Z leg retracts, a -Z leg extends); swing brings it forward again with a lift. At the bind pose every leg is at full reach, so 0 is the extended end.
      const stance = c < g.duty
      const q = stance ? c / g.duty : 1 - (c - g.duty) / (1 - g.duty)
      const f = feet.get(name)
      if (!stance) f[1] += g.lift * Math.sin((Math.PI * (c - g.duty)) / (1 - g.duty))
      f[2] += leg.tag === 'R' ? -stride * q : stride * (1 - q)
    }
  }
  for (const [name, tracks] of Object.entries(spec.ik ?? {})) {
    if (!feet.has(name)) throw new Error(`clip ${spec.name}: no leg ${name}`)
    const f = feet.get(name)
    f[0] += sample(tracks.dx, t)
    f[1] += sample(tracks.dy, t)
    f[2] += sample(tracks.dz, t)
  }

  const root = spec.root ?? {}
  const body = rig.bones[0]
  const W = new Array(rig.bones.length)
  const rootR = eulerDeg(sample(root.rx, t), sample(root.ry, t), sample(root.rz, t))
  W[0] = mul(translate([0, sample(root.dy, t), 0]), rotAbout(rootR, body.at))
  rig.bones.forEach((b, i) => {
    if (i === 0) return
    const fk = spec.fk?.[b.name] ?? {}
    let R = eulerDeg(sample(fk.rx, t), sample(fk.ry, t), sample(fk.rz, t))
    const m = /^Leg(\d)(Upper|Lower)\.([RL])$/.exec(b.name)
    if (m) {
      const key = `Leg${m[1]}.${m[3]}`
      const off = feet.get(key)
      const mag = len(off)
      if (mag > 1e-9) {
        const { Ru, Rl } = solveLeg(rig, legs.get(key), off)
        R = ease(m[2] === 'Upper' ? Ru : Rl, Math.min(1, mag / IK_RAMP))
      }
    }
    if (/^ClawFinger/.test(b.name) && fk.open !== undefined) R = axisAngle(fingerAxis(rig, i), (sample(fk.open, t) * Math.PI) / 180)
    W[i] = mul(W[b.parent], rotAbout(R, b.at))
  })
  return W
}

// --- half floats and the file ---------------------------------------------------

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer)
export function toHalf(x) {
  f32[0] = x
  const b = u32[0], sign = (b >>> 16) & 0x8000
  let e = ((b >>> 23) & 0xff) - 127 + 15, m = b & 0x7fffff
  if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13) }
  if (e >= 31) return sign | 0x7c00
  const r = sign | (e << 10) | (m >> 13)
  return (m & 0x1000) ? r + 1 : r
}
export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

export function readSpecs() {
  if (!SELF_BAKED.has('crab')) throw new Error('ship-crab: build.mjs must list crab in SELF_BAKED')
  const specs = fs.readdirSync(CLIPS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(CLIPS, f), 'utf8')))
  const walk = specs.filter((s) => s.kind === 'walk')
  if (walk.length !== 1) throw new Error(`ship-crab: want exactly one walk clip, have ${walk.length}`)
  return [walk[0], ...specs.filter((s) => s.kind === 'idle')]
}

/** The baked file's header and its Uint16 texels, plus the rig it was baked on. */
export function bake() {
  const { rig, tiers } = loadTiers()
  const specs = readSpecs()
  const bones = rig.bones.length
  const rows = []
  const clips = specs.map((spec) => {
    const base = rows.length
    for (let f = 0; f < spec.frames; f++) {
      const W = evalClip(spec, rig, f / spec.frames)
      const row = new Uint16Array(bones * 12)
      W.forEach((m, b) => { for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) row[b * 12 + r * 4 + c] = toHalf(m[r * 4 + c]) })
      rows.push(row)
    }
    const g = spec.gait
    return { name: spec.name, kind: spec.kind, base, frames: spec.frames, seconds: spec.seconds ?? 0, weight: spec.weight ?? 0, ...(g ? { cycle: g.stride / g.duty } : {}) }
  })
  const header = { bones, rows: rows.length, clips, tiers: tiers.map((t) => Array.from(t.bone)) }
  const data = new Uint16Array(rows.length * bones * 12)
  rows.forEach((r, i) => data.set(r, i * bones * 12))
  return { header, data, rig, tiers }
}

export function encode({ header, data }) {
  let json = JSON.stringify(header)
  while (Buffer.byteLength(json) % 4) json += ' '
  const out = Buffer.alloc(4 + Buffer.byteLength(json) + data.byteLength)
  out.writeUInt32LE(Buffer.byteLength(json), 0)
  out.write(json, 4)
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 4 + Buffer.byteLength(json))
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baked = bake()
  const bytes = encode(baked)
  fs.writeFileSync(OUT, bytes)
  console.log(`${path.relative(process.cwd(), OUT)}: ${bytes.length} bytes, ${baked.header.bones} bones x ${baked.header.rows} rows`)
  for (const c of baked.header.clips) console.log(' ', c.name.padEnd(14), c.kind, 'rows', c.base, '+', c.frames, c.seconds ? `${c.seconds}s` : `cycle ${c.cycle.toFixed(3)}`)
}
