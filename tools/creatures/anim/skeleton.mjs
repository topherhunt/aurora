/**
 * The joint hierarchy of a rigged GLB, plus the vector and quaternion maths the
 * animation tools need on top of what apply-rig-edit.mjs already provides.
 *
 * Everything here is read-only and rest-pose: `world(j)` is where joint `j` sits
 * before any animation. The gait solver works in this frame and hands back local
 * rotations, which is what a glTF animation channel stores.
 */

import { compose, decompose, invert, localOf, mul, readGlb } from '../apply-rig-edit.mjs'

// --- vectors ----------------------------------------------------------------

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a) => Math.hypot(a[0], a[1], a[2])
export const norm = (a) => {
  const l = len(a)
  if (l < 1e-12) throw new Error('cannot normalise a zero-length vector')
  return [a[0] / l, a[1] / l, a[2] / l]
}
/** Transform a point by a 3x4 (translation included). */
export const xform = (m, p) => [
  m[0] * p[0] + m[3] * p[1] + m[6] * p[2] + m[9],
  m[1] * p[0] + m[4] * p[1] + m[7] * p[2] + m[10],
  m[2] * p[0] + m[5] * p[1] + m[8] * p[2] + m[11],
]
/** Transform a direction by a 3x4 (translation ignored). */
export const xformDir = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
]

// --- quaternions ------------------------------------------------------------
//
// glTF order throughout: [x, y, z, w].

export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]]
export const qNorm = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3])
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
export const qAxisAngle = (axis, angle) => {
  const a = norm(axis), s = Math.sin(angle / 2)
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)]
}
export const qRotate = (q, v) => {
  const [x, y, z, w] = q
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
  return [
    v[0] + w * t[0] + y * t[2] - z * t[1],
    v[1] + w * t[1] + z * t[0] - x * t[2],
    v[2] + w * t[2] + x * t[1] - y * t[0],
  ]
}
/** The shortest rotation taking direction `from` onto direction `to`. */
export function qBetween(from, to) {
  const a = norm(from), b = norm(to)
  const d = dot(a, b)
  if (d > 1 - 1e-9) return [0, 0, 0, 1]
  // Antiparallel: the axis is free, so pick any perpendicular one rather than
  // let the cross product collapse to zero and produce a NaN quaternion.
  if (d < -1 + 1e-9) {
    const axis = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])
    return qAxisAngle(axis, Math.PI)
  }
  const c = cross(a, b)
  return qNorm([c[0], c[1], c[2], 1 + d])
}

// --- the skeleton ------------------------------------------------------------

/**
 * Read a rigged GLB into a joint hierarchy.
 *
 * `joints` is in skin order, which is also the order inverse bind matrices are
 * stored in. `world` and `rest` are the bind pose: nothing here reads or honours
 * an animation the file may already carry.
 */
export function loadSkeleton(file) {
  const { json, bin } = readGlb(file)
  const skin = json.skins?.[0]
  if (!skin) throw new Error(`${file} has no skin -- it is a mesh, not a rig`)

  const nodes = json.nodes
  const parent = new Map()
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))

  const joints = skin.joints.slice()
  const isJoint = new Set(joints)
  const name = (i) => nodes[i].name ?? `node${i}`

  const worldCache = new Map()
  const world = (i) => {
    if (worldCache.has(i)) return worldCache.get(i)
    const p = parent.get(i)
    const m = p === undefined ? localOf(nodes[i]) : mul(world(p), localOf(nodes[i]))
    worldCache.set(i, m)
    return m
  }
  const pos = (i) => {
    const m = world(i)
    return [m[9], m[10], m[11]]
  }

  /** Joint children only -- a mesh node parented into the rig is not a bone. */
  const childrenOf = (i) => (nodes[i].children ?? []).filter((c) => isJoint.has(c))

  return {
    file, json, bin, nodes, joints, parent, name, world, pos, childrenOf, isJoint,
    /** The joint's own rest rotation, which animation channels replace. */
    restRotation: (i) => decompose(localOf(nodes[i])).rotation,
    restLocal: (i) => localOf(nodes[i]),
    /** Chain from `j` up to (and excluding) the root, nearest parent first. */
    ancestors: (j) => {
      const out = []
      for (let k = parent.get(j); k !== undefined; k = parent.get(k)) out.push(k)
      return out
    },
    /** Leaf joints: joints with no joint children. */
    leaves: () => joints.filter((j) => childrenOf(j).length === 0),
  }
}

export { compose, decompose, invert, mul }
