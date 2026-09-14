// Apply a rig-edit sidecar to a rigged glb: rename joints, reparent them,
// delete them, move them, and write a new file. rig-edit.html is what authors
// the sidecar; this is what turns it into a glb the rest of the pipeline uses.
//
//   node tools/creatures/apply-rig-edit.mjs red-fox
//   node tools/creatures/apply-rig-edit.mjs red-fox --in anim-walk.glb --out fixed.glb
//
// The sidecar is a small JSON file next to the rig. Every key in it is stated
// in terms of the ORIGINAL node names in the input glb -- never an edited name,
// so a sidecar stays readable against the file it was authored from and
// applying it twice is not a different operation from applying it once:
//
//   { "reparent": { "bone_1": "0_Left_Limb_0" },
//     "renames":  { "0_Left_Limb_0": "Body", "bone_1": "Tail1" },
//     "delete":   [ "bone_14" ],
//     "moves":    { "bone_26": [0, 0.31, -0.12] } }
//
// `moves` is a new WORLD position for the joint, in the glb's own coordinates.
//
// WHAT EACH OPERATION DOES TO THE SKIN, which is the whole difficulty here.
// glTF deforms a vertex by worldMatrix(joint) * inverseBindMatrix(joint), and
// at rest those two are inverses, so the product is the identity and the mesh
// sits exactly as modelled. Each operation has to leave that true:
//
//   RENAME touches nothing but a string.
//
//   REPARENT preserves the joint's world transform by rewriting its local TRS,
//   so both halves of the product are unchanged. Nothing else has to move.
//
//   MOVE deliberately changes the joint's world transform, which would tear the
//   mesh -- so its inverse bind matrix is recomputed to match, and the rest pose
//   comes out identical. What changes is where the joint PIVOTS when animated,
//   which is the entire point. The joint's children are compensated so they
//   stay where they are: moving a hip up must not drag the feet up with it.
//
//   DELETE closes the chain over the gap -- the deleted joint's children adopt
//   its nearest surviving ancestor, keeping their world transforms -- and hands
//   its skin weights to that same ancestor, folding influences that now name
//   the same joint. Every remaining joint index in the mesh is renumbered, the
//   inverse bind matrix array is rebuilt one entry shorter, and the node leaves
//   json.nodes, which renumbers every index into it in the whole file.
//
// Tripo's rigs need all four: on red-fox the tail and both hind legs hang off a
// ground-level root as siblings of the spine, several joints sit at ground level
// where a hip belongs, and there are more joints than the Mixamo vocabulary in
// tools/creatures/mixamo-rig.mjs has names for.

import fs from 'node:fs'
import path from 'node:path'
import { workDir } from './workspace.mjs'

// --- glb container ----------------------------------------------------------

const MAGIC = 0x46546C67
const JSON_CHUNK = 0x4E4F534A
const BIN_CHUNK = 0x004E4942

export function readGlb(file) {
  const buf = fs.readFileSync(file)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== MAGIC) throw new Error(`${file} is not a glb`)
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(body))
    if (type === BIN_CHUNK) bin = Buffer.from(body)
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error(`${file} has no JSON chunk`)
  return { json, bin }
}

export function writeGlb(file, json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  // Both chunks pad to a 4-byte boundary, JSON with spaces and BIN with zeros,
  // and a decoder that trusts the declared length will read the padding.
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + bin.length + binPad : 0)
  const out = Buffer.alloc(total)
  out.writeUInt32LE(MAGIC, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12)
  out.writeUInt32LE(JSON_CHUNK, 16)
  jsonBytes.copy(out, 20)
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad)
  if (bin) {
    const at = 20 + jsonBytes.length + jsonPad
    out.writeUInt32LE(bin.length + binPad, at)
    out.writeUInt32LE(BIN_CHUNK, at + 4)
    bin.copy(out, at + 8)
  }
  fs.writeFileSync(file, out)
  return out
}

// --- affine transforms ------------------------------------------------------
//
// Column-major 3x4: three basis columns then the translation. A joint hierarchy
// needs nothing wider -- no projection, no shear beyond what a scale gives.

export function compose(t, q, s) {
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

export function mul(a, b) {
  const m = new Array(12)
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      m[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
    }
  }
  for (let r = 0; r < 3; r++) m[9 + r] = a[r] * b[9] + a[3 + r] * b[10] + a[6 + r] * b[11] + a[9 + r]
  return m
}

export function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e)
  if (Math.abs(det) < 1e-20) throw new Error('joint transform is singular -- a zero scale somewhere in the chain')
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ]
  const [tx, ty, tz] = [m[9], m[10], m[11]]
  return [
    ...inv,
    -(inv[0] * tx + inv[3] * ty + inv[6] * tz),
    -(inv[1] * tx + inv[4] * ty + inv[7] * tz),
    -(inv[2] * tx + inv[5] * ty + inv[8] * tz),
  ]
}

export function decompose(m) {
  let sx = Math.hypot(m[0], m[1], m[2])
  const sy = Math.hypot(m[3], m[4], m[5])
  const sz = Math.hypot(m[6], m[7], m[8])
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4])
  if (det < 0) sx = -sx
  // The three orthonormal basis columns, named for the axis each one is.
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = [m[0] / sx, m[1] / sx, m[2] / sx, m[3] / sy, m[4] / sy, m[5] / sy, m[6] / sz, m[7] / sz, m[8] / sz]
  // Shepperd's method: take the square root off whichever diagonal term is
  // largest, so the divisor is never near zero for a half-turn rotation.
  const trace = xx + yy + zz
  let q
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(yz - zy) / s, (zx - xz) / s, (xy - yx) / s, s / 4]
  } else if (xx > yy && xx > zz) {
    const s = Math.sqrt(1 + xx - yy - zz) * 2
    q = [s / 4, (yx + xy) / s, (zx + xz) / s, (yz - zy) / s]
  } else if (yy > zz) {
    const s = Math.sqrt(1 + yy - xx - zz) * 2
    q = [(yx + xy) / s, s / 4, (zy + yz) / s, (zx - xz) / s]
  } else {
    const s = Math.sqrt(1 + zz - xx - yy) * 2
    q = [(zx + xz) / s, (zy + yz) / s, s / 4, (xy - yx) / s]
  }
  const len = Math.hypot(...q)
  return { translation: [m[9], m[10], m[11]], rotation: q.map((v) => v / len), scale: [sx, sy, sz] }
}

/** A node's local transform, from either spelling glTF allows. */
const localOf = (node) => {
  const m = node.matrix
  if (!m) return compose(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1])
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]]
}

/** Our 3x4 widened back out to the column-major 4x4 glTF stores. */
const widen = (m) => [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]

// --- typed accessor io ------------------------------------------------------
//
// Enough of the accessor spec to rewrite skinning data in place: no sparse
// accessors, but interleaved bufferViews are honoured, because reading a stride
// wrong corrupts a mesh in a way that only shows up as a shrug in a viewport.

const COMPONENT = {
  5120: { array: Int8Array, bytes: 1, get: 'getInt8', set: 'setInt8' },
  5121: { array: Uint8Array, bytes: 1, get: 'getUint8', set: 'setUint8' },
  5122: { array: Int16Array, bytes: 2, get: 'getInt16', set: 'setInt16' },
  5123: { array: Uint16Array, bytes: 2, get: 'getUint16', set: 'setUint16' },
  5125: { array: Uint32Array, bytes: 4, get: 'getUint32', set: 'setUint32' },
  5126: { array: Float32Array, bytes: 4, get: 'getFloat32', set: 'setFloat32' },
}
const ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

function layoutOf(json, index) {
  const acc = json.accessors[index]
  if (acc.sparse) throw new Error('this glb uses a sparse accessor, which the rig editor cannot rewrite')
  if (acc.bufferView === undefined) throw new Error('this glb has an accessor with no bufferView, which the rig editor cannot rewrite')
  const comp = COMPONENT[acc.componentType]
  if (!comp) throw new Error(`unknown accessor componentType ${acc.componentType}`)
  const items = ITEMS[acc.type]
  const view = json.bufferViews[acc.bufferView]
  return { acc, comp, items, base: (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride: view.byteStride ?? comp.bytes * items }
}

export function readAccessor(json, bin, index) {
  const { acc, comp, items, base, stride } = layoutOf(json, index)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const out = new comp.array(acc.count * items)
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < items; c++) out[i * items + c] = dv[comp.get](base + i * stride + c * comp.bytes, true)
  }
  return out
}

function writeAccessor(json, bin, index, values) {
  const { acc, comp, items, base, stride } = layoutOf(json, index)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < items; c++) dv[comp.set](base + i * stride + c * comp.bytes, values[i * items + c], true)
  }
}

/**
 * Park bytes at the end of the BIN chunk and hand back a bufferView for them.
 * The array they replace stays in the file as unreferenced bytes -- a couple of
 * KB -- because reclaiming it would mean shifting every byteOffset after it.
 */
function appendData(json, appended, bytes) {
  json.bufferViews.push({ buffer: 0, byteOffset: appended.at, byteLength: bytes.length })
  appended.parts.push(bytes)
  appended.at += bytes.length
  const pad = (4 - (bytes.length % 4)) % 4
  if (pad) {
    appended.parts.push(Buffer.alloc(pad))
    appended.at += pad
  }
  return json.bufferViews.length - 1
}

// --- the edit ---------------------------------------------------------------

const EMPTY = { renames: {}, reparent: {}, delete: [], moves: {} }

/**
 * Mutates `json` in place. Returns a report of what changed plus the BIN chunk
 * to write, which is the buffer that came in unless a delete or a move forced
 * skinning data to be rewritten.
 *
 * `bin` may be omitted for a file with no skin. An edit that needs it and does
 * not have it says so rather than quietly writing a torn mesh.
 */
export function applyRigEdit(json, edit, bin = null) {
  for (const key of Object.keys(edit)) {
    if (!(key in EMPTY)) throw new Error(`unknown key "${key}" in the rig edit -- only ${Object.keys(EMPTY).join(', ')} are understood`)
  }
  const renames = edit.renames ?? {}
  const reparent = edit.reparent ?? {}
  const removals = edit.delete ?? []
  const moves = edit.moves ?? {}
  if (!Array.isArray(removals)) throw new Error('"delete" must be a list of node names')

  if (json.nodes.some((n) => !n.name)) throw new Error('this glb has unnamed nodes, so a name-keyed edit cannot address it')
  const byName = new Map()
  for (let i = 0; i < json.nodes.length; i++) {
    if (byName.has(json.nodes[i].name)) throw new Error(`node name "${json.nodes[i].name}" appears twice -- a name-keyed edit is ambiguous against this file`)
    byName.set(json.nodes[i].name, i)
  }
  const index = (name, role) => {
    if (!byName.has(name)) throw new Error(`the edit names "${name}" as a ${role}, and this glb has no such node`)
    return byName.get(name)
  }

  // The parent map and the world transforms both come from the hierarchy as it
  // stands BEFORE any edit, and stay the reference frame for the whole pass.
  const parentOf = new Array(json.nodes.length).fill(-1)
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parentOf[c] = i }))
  const world = new Array(json.nodes.length).fill(null)
  const worldOf = (i) => {
    if (world[i]) return world[i]
    const local = localOf(json.nodes[i])
    world[i] = parentOf[i] < 0 ? local : mul(worldOf(parentOf[i]), local)
    return world[i]
  }
  json.nodes.forEach((_, i) => worldOf(i))

  // --- what the edit asks for -----------------------------------------------

  const doomed = new Set(removals.map((name) => index(name, 'deleted node')))
  const survivorOf = (i) => {
    for (let a = parentOf[i]; a >= 0; a = parentOf[a]) if (!doomed.has(a)) return a
    return -1
  }
  for (const i of doomed) {
    // The mesh check comes first: a mesh node is usually a scene root, so the
    // ancestor check below would otherwise answer a different question.
    if (json.nodes[i].mesh !== undefined) throw new Error(`"${json.nodes[i].name}" carries a mesh, so deleting it would delete geometry, not a joint`)
    if (survivorOf(i) < 0) throw new Error(`deleting "${json.nodes[i].name}" would leave its children with no parent -- nothing above it survives the edit`)
  }

  // Only a move changes a joint's intended world transform. Its basis is kept:
  // a move is a translation, so the joint's rest orientation and scale survive.
  const desired = world.map((m) => m.slice())
  const relocated = new Set()
  const repositioned = []
  for (const [name, at] of Object.entries(moves)) {
    const i = index(name, 'moved node')
    if (doomed.has(i)) throw new Error(`the edit both moves and deletes "${name}"`)
    if (!Array.isArray(at) || at.length !== 3 || at.some((v) => !Number.isFinite(v))) {
      throw new Error(`the move for "${name}" is not three finite numbers`)
    }
    desired[i][9] = at[0]
    desired[i][10] = at[1]
    desired[i][11] = at[2]
    relocated.add(i)
    repositioned.push(`${name} -> ${at.map((v) => v.toFixed(4)).join(', ')}`)
  }

  // --- the hierarchy the edit asks for --------------------------------------

  const finalParent = parentOf.slice()
  for (let i = 0; i < finalParent.length; i++) {
    if (doomed.has(i)) continue
    while (finalParent[i] >= 0 && doomed.has(finalParent[i])) finalParent[i] = parentOf[finalParent[i]]
  }
  const moved = []
  for (const [childName, parentName] of Object.entries(reparent)) {
    const child = index(childName, 'reparented node')
    const parent = index(parentName, 'new parent')
    if (doomed.has(child)) throw new Error(`the edit both reparents and deletes "${childName}"`)
    if (doomed.has(parent)) throw new Error(`the edit parents "${childName}" to "${parentName}", which it also deletes`)
    if (child === parent) throw new Error(`cannot parent "${childName}" to itself`)
    if (finalParent[child] === parent) continue
    finalParent[child] = parent
    moved.push(`${childName} -> ${parentName}`)
  }
  // Only checkable once every reparent is in: two moves can each be innocent
  // and still close a loop together.
  for (let i = 0; i < finalParent.length; i++) {
    if (doomed.has(i)) continue
    let steps = 0
    for (let a = finalParent[i]; a >= 0; a = finalParent[a]) {
      if (a === i || ++steps > finalParent.length) throw new Error(`the edit makes a cycle through "${json.nodes[i].name}"`)
    }
  }

  // --- skinning -------------------------------------------------------------

  const appended = { at: bin ? bin.length : 0, parts: [] }
  let outBin = bin
  if ((doomed.size || relocated.size) && json.skins?.length) {
    if (!bin) throw new Error('deleting or moving a joint has to rewrite skinning data, and this glb was read without its BIN chunk')
    if (json.skins.length > 1) throw new Error('this glb has more than one skin, which the rig editor cannot reweight')
    const skin = json.skins[0]
    const kept = skin.joints.filter((n) => !doomed.has(n))
    const slotOfNode = new Map(kept.map((n, k) => [n, k]))

    // Where each old joint slot's influence ends up. A deleted joint hands its
    // weight to the nearest surviving joint above it; if that ancestor is not
    // itself part of the skin there is nowhere for the weight to go.
    const slotRemap = skin.joints.map((n) => {
      const target = doomed.has(n) ? survivorOf(n) : n
      const slot = slotOfNode.get(target)
      if (slot === undefined) {
        throw new Error(`deleting "${json.nodes[n].name}" has nowhere to put its skin weights -- "${json.nodes[target].name}" above it is not a joint of this skin`)
      }
      return slot
    })

    const rewritten = new Set()
    for (const node of json.nodes) {
      if (node.mesh === undefined || node.skin !== 0) continue
      for (const prim of json.meshes[node.mesh].primitives) {
        const jointsAt = prim.attributes.JOINTS_0
        const weightsAt = prim.attributes.WEIGHTS_0
        if (jointsAt === undefined || rewritten.has(jointsAt)) continue
        if (prim.attributes.JOINTS_1 !== undefined) throw new Error('this mesh puts more than four influences on a vertex (JOINTS_1), which the rig editor cannot reweight')
        if (json.accessors[weightsAt].componentType !== 5126) throw new Error('this mesh stores skin weights as normalized integers, which the rig editor cannot reweight')
        rewritten.add(jointsAt)

        const joints = readAccessor(json, bin, jointsAt)
        const weights = readAccessor(json, bin, weightsAt)
        for (let v = 0; v < json.accessors[weightsAt].count; v++) {
          const at = v * 4
          for (let c = 0; c < 4; c++) joints[at + c] = slotRemap[joints[at + c]]
          // Two of a vertex's four influences can now name the same joint. Fold
          // them together: leaving both would keep only whichever the GPU reads
          // last, and the vertex would quietly lose that much weight.
          for (let c = 0; c < 4; c++) {
            if (weights[at + c] === 0) { joints[at + c] = 0; continue }
            for (let d = c + 1; d < 4; d++) {
              if (weights[at + d] !== 0 && joints[at + d] === joints[at + c]) {
                weights[at + c] += weights[at + d]
                weights[at + d] = 0
                joints[at + d] = 0
              }
            }
          }
        }
        writeAccessor(json, bin, jointsAt, joints)
        writeAccessor(json, bin, weightsAt, weights)
      }
    }

    // The inverse bind matrices are what keep the rest pose identical through a
    // move, so they are rebuilt from the transforms the edit asks for, not the
    // ones the file came with.
    const ibm = new Float32Array(kept.length * 16)
    kept.forEach((n, k) => ibm.set(widen(invert(desired[n])), k * 16))
    const view = appendData(json, appended, Buffer.from(ibm.buffer, ibm.byteOffset, ibm.byteLength))
    if (skin.inverseBindMatrices === undefined) {
      json.accessors.push({ bufferView: view, componentType: 5126, count: kept.length, type: 'MAT4' })
      skin.inverseBindMatrices = json.accessors.length - 1
    } else {
      const acc = json.accessors[skin.inverseBindMatrices]
      Object.assign(acc, { bufferView: view, byteOffset: 0, componentType: 5126, count: kept.length, type: 'MAT4' })
      delete acc.min
      delete acc.max
    }
    skin.joints = kept
    if (skin.skeleton !== undefined && doomed.has(skin.skeleton)) skin.skeleton = survivorOf(skin.skeleton)
  }

  // --- the local transforms the edit actually disturbed ----------------------
  //
  // A node's local transform is a function of its own desired world transform
  // and its parent's, so only those three situations need rewriting. Leaving
  // the rest alone keeps their authored values exact instead of round-tripping
  // every joint in the file through a decompose.

  for (let i = 0; i < json.nodes.length; i++) {
    if (doomed.has(i)) continue
    const parent = finalParent[i]
    if (parent === parentOf[i] && !relocated.has(i) && !(parent >= 0 && relocated.has(parent))) continue
    const local = decompose(parent < 0 ? desired[i] : mul(invert(desired[parent]), desired[i]))
    json.nodes[i].translation = local.translation
    json.nodes[i].rotation = local.rotation
    json.nodes[i].scale = local.scale
    delete json.nodes[i].matrix
  }

  // --- rebuild the hierarchy and close the gaps in json.nodes ---------------
  //
  // Deleted nodes leave the file, so every index INTO json.nodes is renumbered:
  // scene roots, children lists, skin joints and animation channel targets all
  // address nodes by position.

  if (json.scenes.length !== 1) throw new Error('this glb has more than one scene, so the rig editor cannot tell which one a root belongs to')
  if (json.extensionsUsed?.includes('KHR_animation_pointer')) {
    throw new Error('this glb uses KHR_animation_pointer, whose JSON pointers into the document the rig editor cannot renumber')
  }

  const renumbered = []
  let next = 0
  for (let i = 0; i < json.nodes.length; i++) renumbered.push(doomed.has(i) ? -1 : next++)

  for (const node of json.nodes) delete node.children
  const roots = []
  for (let i = 0; i < json.nodes.length; i++) {
    if (doomed.has(i)) continue
    if (finalParent[i] < 0) { roots.push(renumbered[i]); continue }
    const parent = json.nodes[finalParent[i]]
    parent.children = parent.children ?? []
    parent.children.push(renumbered[i])
  }
  json.scenes[0].nodes = roots
  for (const skin of json.skins ?? []) {
    skin.joints = skin.joints.filter((n) => !doomed.has(n)).map((n) => renumbered[n])
    if (skin.skeleton !== undefined) skin.skeleton = renumbered[skin.skeleton]
  }
  for (const animation of json.animations ?? []) {
    animation.channels = animation.channels.filter((c) => c.target.node === undefined || !doomed.has(c.target.node))
    for (const channel of animation.channels) {
      if (channel.target.node !== undefined) channel.target.node = renumbered[channel.target.node]
    }
  }
  const deleted = [...doomed].map((i) => json.nodes[i].name)
  json.nodes = json.nodes.filter((_, i) => !doomed.has(i))

  // --- names ----------------------------------------------------------------

  const renamed = []
  for (const [from, to] of Object.entries(renames)) {
    if (!to) throw new Error(`the edit renames "${from}" to an empty name`)
    const at = index(from, 'renamed node')
    if (doomed.has(at)) throw new Error(`the edit both renames and deletes "${from}"`)
    json.nodes[renumbered[at]].name = to
    renamed.push(`${from} -> ${to}`)
  }
  const after = json.nodes.map((n) => n.name)
  const dupes = after.filter((n, i) => after.indexOf(n) !== i)
  if (dupes.length) throw new Error(`the renames collide: ${[...new Set(dupes)].join(', ')} would each name more than one node`)

  if (appended.parts.length) {
    outBin = Buffer.concat([bin, ...appended.parts])
    json.buffers[0].byteLength = outBin.length
  }
  return { moved, renamed, deleted, repositioned, bin: outBin }
}

/** Read a sidecar, or the empty edit if none has been authored yet. */
export function readRigEdit(file) {
  if (!fs.existsSync(file)) return { ...EMPTY }
  const edit = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    renames: edit.renames ?? {},
    reparent: edit.reparent ?? {},
    delete: edit.delete ?? [],
    moves: edit.moves ?? {},
  }
}

// --- cli --------------------------------------------------------------------

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = process.argv.slice(2)
  const id = args[0]
  if (!id) {
    console.error('usage: node tools/creatures/apply-rig-edit.mjs <creature-id> [--in rig.glb] [--out rig-fixed.glb]')
    process.exit(1)
  }
  const flag = (name, fallback) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : fallback
  }
  const dir = workDir(id)
  const inFile = path.join(dir, flag('in', 'rig.glb'))
  const outFile = path.join(dir, flag('out', 'rig-fixed.glb'))
  const editFile = path.join(dir, 'rig-edit.json')

  const { json, bin } = readGlb(inFile)
  const edit = readRigEdit(editFile)
  const report = applyRigEdit(json, edit, bin)
  writeGlb(outFile, json, report.bin)

  console.log(`${path.relative(process.cwd(), inFile)} + ${path.basename(editFile)} -> ${path.relative(process.cwd(), outFile)}`)
  console.log(`  ${report.moved.length} reparented, ${report.renamed.length} renamed, ${report.deleted.length} deleted, ${report.repositioned.length} moved`)
  for (const group of ['moved', 'renamed', 'deleted', 'repositioned']) {
    for (const line of report[group]) console.log(`    ${group}: ${line}`)
  }
}
