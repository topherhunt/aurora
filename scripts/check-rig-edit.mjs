// Gates tools/creatures/apply-rig-edit.mjs.
//
//   node scripts/check-rig-edit.mjs
//
// The invariant worth a gate is not "the names changed" -- it is that AN EDIT
// DOES NOT DISTURB THE ANIMAL AT REST. Every operation the editor offers has to
// leave worldMatrix * inverseBindMatrix at the identity for every joint, and if
// that arithmetic is even slightly wrong the mesh silently tears instead of
// erroring. Nothing downstream would report it, and a viewport would show a
// creature that is merely a bit wrong.
//
// Reparenting holds it by preserving world transforms. Moving holds it by
// recomputing the inverse bind matrix to match the new one. Deleting holds it
// by handing weights up to the surviving ancestor, folding influences that now
// name the same joint, and rebuilding the matrix array one entry shorter.
//
// So the checks below rebuild every joint's world transform from scratch after
// the edit, multiply it back through the inverse bind matrices, and compare
// against what it was before -- plus the guards that stop an edit from
// producing a file that cannot be loaded at all.

import { applyRigEdit, compose, decompose, invert, mul, readAccessor } from '../tools/creatures/apply-rig-edit.mjs'
import { HIERARCHY, QUATERNIUS_TO_MIXAMO, REQUIRED, descends, expectedParent } from '../tools/creatures/mixamo-rig.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const message = (fn) => { try { fn(); return '' } catch (e) { return e.message } }

// --- fixtures ---------------------------------------------------------------

/** A normalized quaternion -- an unnormalized one composes to a matrix with a
 *  scale baked in, which decompose would then correctly report and this file
 *  would then wrongly call a bug. */
const quat = (x, y, z, w) => { const l = Math.hypot(x, y, z, w); return [x / l, y / l, z / l, w / l] }

/**
 * A miniature of the fault this tool exists to fix: a spine, and a tail that
 * hangs off the ground-level root as the spine's sibling rather than off its
 * rear. Rotating `spine` here leaves the tail behind, exactly as red-fox does.
 */
function brokenRig() {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'root', children: [1, 4], translation: [0, 0.1, 0] },
      { name: 'spine', children: [2], translation: [0, 0.4, 0], rotation: quat(0.13, 0.25, 0.06, 0.9553), scale: [1, 1, 1] },
      { name: 'chest', children: [3], translation: [0, 0.3, 0.05], rotation: quat(0, 0.3827, 0, 0.9239) },
      { name: 'head', translation: [0, 0.2, 0.1] },
      { name: 'tail', translation: [-0.2, 0.45, 0.3], rotation: quat(0.5, 0, 0, 0.866), scale: [1.2, 1.2, 1.2] },
    ],
  }
}

const localOf = (n) => compose(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1])

/** Every node's world transform, keyed by name, rebuilt from the hierarchy. */
function worlds(json) {
  const parentOf = new Array(json.nodes.length).fill(-1)
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parentOf[c] = i }))
  const out = new Map()
  const at = (i) => {
    const local = localOf(json.nodes[i])
    return parentOf[i] < 0 ? local : mul(at(parentOf[i]), local)
  }
  json.nodes.forEach((n, i) => out.set(n.name, at(i)))
  return out
}

const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

// --- the matrix arithmetic underneath ---------------------------------------

console.log('\naffine helpers')
{
  const m = compose([1.5, -2, 0.25], quat(0.13, 0.25, 0.06, 0.9553), [1, 1, 1])
  const back = decompose(m)
  check(maxDiff(compose(back.translation, back.rotation, back.scale), m) < 1e-6,
    'decompose inverts compose', maxDiff(compose(back.translation, back.rotation, back.scale), m).toExponential(1))

  // A quaternion and its negation are the same rotation, so the round trip is
  // only required to agree up to sign.
  const q = quat(0.13, 0.25, 0.06, 0.9553)
  const sign = back.rotation[3] < 0 ? -1 : 1
  check(Math.max(...q.map((v, i) => Math.abs(v - back.rotation[i] * sign))) < 1e-6, 'and recovers the quaternion up to sign')

  const scaled = compose([0, 1, 0], quat(0, 0.3827, 0, 0.9239), [2, 0.5, 3])
  const s = decompose(scaled).scale
  check(Math.abs(s[0] - 2) < 1e-6 && Math.abs(s[1] - 0.5) < 1e-6 && Math.abs(s[2] - 3) < 1e-6,
    'and separates a non-uniform scale from the rotation', s.map((v) => v.toFixed(3)).join(' '))

  const identity = mul(scaled, invert(scaled))
  check(maxDiff(identity, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) < 1e-6, 'invert undoes a scaled, rotated, translated frame')

  // A half turn is where a naive trace-only quaternion extraction divides by
  // zero, which is the whole reason decompose branches on the largest diagonal.
  const halfTurn = compose([0, 0, 0], [0, 1, 0, 0], [1, 1, 1])
  const hq = decompose(halfTurn).rotation
  check(maxDiff(compose([0, 0, 0], hq, [1, 1, 1]), halfTurn) < 1e-6, 'and a 180 degree rotation survives the round trip', hq.map((v) => v.toFixed(3)).join(' '))
}

// --- reparenting ------------------------------------------------------------

console.log('\nreparenting preserves the pose')
{
  const json = brokenRig()
  const before = worlds(json)
  const report = applyRigEdit(json, { reparent: { tail: 'spine' } })

  const after = worlds(json)
  const worst = Math.max(...[...before.keys()].map((name) => maxDiff(before.get(name), after.get(name))))
  check(worst < 1e-6, 'every joint keeps its world transform when the tail moves under the spine', worst.toExponential(1))

  check(json.nodes[1].children.includes(4), 'the tail is now a child of the spine')
  check(!json.nodes[0].children.includes(4), 'and no longer a child of the root')
  check(report.moved.length === 1 && report.renamed.length === 0, 'the report says one move and no renames')

  // The point of the whole exercise: the back half now follows the front.
  const rotated = brokenRig()
  applyRigEdit(rotated, { reparent: { tail: 'spine' } })
  rotated.nodes[1].rotation = [0, 0.7071, 0, 0.7071]
  const swung = worlds(rotated).get('tail')
  const still = worlds(brokenRig()).get('tail')
  check(maxDiff(swung, still) > 0.1, 'and rotating the spine now takes the tail with it', maxDiff(swung, still).toFixed(3))
}

console.log('\nreparenting a scene root')
{
  const json = brokenRig()
  json.scenes[0].nodes = [0, 5]
  json.nodes.push({ name: 'stray', translation: [1, 1, 1] })
  const before = worlds(json)
  applyRigEdit(json, { reparent: { stray: 'chest' } })
  check(!json.scenes[0].nodes.includes(5), 'a node listed in the scene is removed from the scene, not just from a parent')
  check(json.nodes[2].children.includes(5), 'and is attached to its new parent')
  check(maxDiff(before.get('stray'), worlds(json).get('stray')) < 1e-6, 'and keeps its world transform')
}

console.log('\nedits that must be refused')
{
  check(throws(() => applyRigEdit(brokenRig(), { reparent: { spine: 'head' } })), 'parenting a joint to its own descendant is a cycle')
  check(message(() => applyRigEdit(brokenRig(), { reparent: { spine: 'head' } })).includes('cycle'), 'and the error says so')
  check(throws(() => applyRigEdit(brokenRig(), { reparent: { spine: 'spine' } })), 'parenting a joint to itself')
  check(throws(() => applyRigEdit(brokenRig(), { reparent: { spine: 'nope' } })), 'naming a parent that is not in the file')
  check(throws(() => applyRigEdit(brokenRig(), { renames: { nope: 'Hips' } })), 'renaming a node that is not in the file')
  check(throws(() => applyRigEdit(brokenRig(), { renames: { spine: '' } })), 'renaming to an empty string')
  check(throws(() => applyRigEdit(brokenRig(), { renames: { spine: 'chest' } })), 'a rename that collides with another node')
  check(throws(() => applyRigEdit(brokenRig(), { scale: { spine: 2 } })), 'an edit key this tool does not implement')
  const unnamed = brokenRig()
  delete unnamed.nodes[3].name
  check(throws(() => applyRigEdit(unnamed, { renames: { spine: 'Hips' } })), 'a file with unnamed nodes, which a name-keyed edit cannot address')
}

console.log('\nrenaming')
{
  const json = brokenRig()
  const before = worlds(json)
  applyRigEdit(json, { reparent: { tail: 'spine' }, renames: { spine: 'Hips', chest: 'Spine', tail: 'Tail' } })
  check(json.nodes.map((n) => n.name).join(' ') === 'root Hips Spine head Tail', 'names land on the right nodes', json.nodes.map((n) => n.name).join(' '))

  // Both maps are keyed by the ORIGINAL names, so a reparent and a rename of
  // the same joint in one edit is not order-dependent for the author.
  const after = worlds(json)
  check(maxDiff(before.get('tail'), after.get('Tail')) < 1e-6, 'and a joint renamed and reparented in one edit still holds its pose')
}

// --- a fixture with a skin, because deleting and moving rewrite vertex data --

/**
 * The same spine as brokenRig(), plus a three-vertex skinned mesh. Small enough
 * to reason about by hand: v0 is shared between spine and chest, v1 between
 * chest and head, v2 belongs to the tail alone.
 */
function skinnedRig() {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 5] }],
    nodes: [
      { name: 'root', children: [1], translation: [0, 0.1, 0] },
      { name: 'spine', children: [2, 4], translation: [0, 0.4, 0], rotation: quat(0.13, 0.25, 0.06, 0.9553) },
      { name: 'chest', children: [3], translation: [0, 0.3, 0.05], rotation: quat(0, 0.3827, 0, 0.9239) },
      { name: 'head', translation: [0, 0.2, 0.1] },
      { name: 'tail', translation: [-0.2, 0.05, 0.3], rotation: quat(0.5, 0, 0, 0.866) },
      { name: 'body', mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { JOINTS_0: 0, WEIGHTS_0: 1 } }] }],
    skins: [{ joints: [1, 2, 3, 4], inverseBindMatrices: 2 }],
    accessors: [
      { bufferView: 0, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'MAT4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 12 },
      { buffer: 0, byteOffset: 16, byteLength: 48 },
      { buffer: 0, byteOffset: 64, byteLength: 256 },
    ],
    buffers: [{ byteLength: 320 }],
  }
  const bin = Buffer.alloc(320)
  // slot 0 spine, 1 chest, 2 head, 3 tail
  Buffer.from([0, 1, 0, 0, 1, 2, 0, 0, 3, 0, 0, 0]).copy(bin, 0)
  const weights = new Float32Array([0.6, 0.4, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0])
  Buffer.from(weights.buffer).copy(bin, 16)
  // At rest the inverse bind matrix is the inverse of the joint's world
  // transform -- measured against tools/creatures/work/red-fox/rig.glb, where
  // the two agree to 3.4e-7, which is float32 noise.
  const w = worlds(json)
  const ibm = new Float32Array(4 * 16)
  const wide = (m) => [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]
  ;['spine', 'chest', 'head', 'tail'].forEach((name, k) => ibm.set(wide(invert(w.get(name))), k * 16))
  Buffer.from(ibm.buffer).copy(bin, 64)
  return { json, bin }
}

/** Every joint's worldMatrix * inverseBindMatrix -- the identity at rest. */
function restResidual(json, bin) {
  const w = worlds(json)
  const ibm = readAccessor(json, bin, json.skins[0].inverseBindMatrices)
  let worst = 0
  json.skins[0].joints.forEach((node, k) => {
    const narrow = [ibm[k * 16], ibm[k * 16 + 1], ibm[k * 16 + 2], ibm[k * 16 + 4], ibm[k * 16 + 5], ibm[k * 16 + 6],
      ibm[k * 16 + 8], ibm[k * 16 + 9], ibm[k * 16 + 10], ibm[k * 16 + 12], ibm[k * 16 + 13], ibm[k * 16 + 14]]
    worst = Math.max(worst, maxDiff(mul(w.get(json.nodes[node].name), narrow), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
  })
  return worst
}

const totalWeight = (json, bin) => [...readAccessor(json, bin, 1)].reduce((a, b) => a + b, 0)

console.log('\ndeleting a joint closes the chain over it')
{
  const { json, bin } = skinnedRig()
  const before = worlds(json)
  const weightBefore = totalWeight(json, bin)
  const report = applyRigEdit(json, { delete: ['chest'] }, bin)

  check(report.deleted.join() === 'chest', 'the report names what went')
  check(!json.nodes.some((n) => n.name === 'chest'), 'the node is gone from the file')
  const after = worlds(json)
  check(maxDiff(before.get('head'), after.get('head')) < 1e-6,
    'the orphaned child keeps its world transform under its new parent', maxDiff(before.get('head'), after.get('head')).toExponential(1))
  check(json.nodes[json.nodes.findIndex((n) => n.name === 'spine')].children.length === 2, 'and hangs off the deleted joint\'s parent alongside its own sibling')
  check(json.skins[0].joints.length === 3, 'the skin is one joint shorter')
  check(readAccessor(json, report.bin, json.skins[0].inverseBindMatrices).length === 48, 'and so is the inverse bind matrix array')
  check(json.skins[0].joints.every((n) => n >= 0 && n < json.nodes.length), 'every remaining joint index still addresses a node')
  check(json.nodes.map((n) => n.name).join(' ') === 'root spine head tail body', 'the surviving nodes renumber without gaps', json.nodes.map((n) => n.name).join(' '))

  const joints = [...readAccessor(json, report.bin, 0)]
  const weights = [...readAccessor(json, report.bin, 1)]
  check(joints.slice(0, 4).join() === '0,0,0,0' && Math.abs(weights[0] - 1) < 1e-6 && weights[1] === 0,
    'a vertex weighted to both the deleted joint and its parent folds into one influence', `${joints.slice(0, 4)} @ ${weights.slice(0, 4)}`)
  check(joints.slice(4, 8).join() === '0,1,0,0' && Math.abs(weights[4] - 0.5) < 1e-6 && Math.abs(weights[5] - 0.5) < 1e-6,
    'a vertex weighted to the deleted joint and an unrelated one moves to the parent', `${joints.slice(4, 8)} @ ${weights.slice(4, 8)}`)
  check(joints.slice(8, 12).join() === '2,0,0,0', 'and an untouched vertex is renumbered to the joint it still means', `${joints.slice(8, 12)}`)
  check(Math.abs(totalWeight(json, report.bin) - weightBefore) < 1e-6,
    'no weight is created or lost anywhere in the mesh', `${totalWeight(json, report.bin).toFixed(4)} vs ${weightBefore.toFixed(4)}`)
  check(restResidual(json, report.bin) < 1e-5, 'and the rest pose is still the identity', restResidual(json, report.bin).toExponential(1))
}

console.log('\nmoving a joint')
{
  const { json, bin } = skinnedRig()
  const before = worlds(json)
  const report = applyRigEdit(json, { moves: { chest: [0.15, 0.9, -0.2] } }, bin)

  const after = worlds(json)
  check(maxDiff(after.get('chest').slice(9), [0.15, 0.9, -0.2]) < 1e-6, 'the joint lands exactly where it was told to')
  check(maxDiff(after.get('chest').slice(0, 9), before.get('chest').slice(0, 9)) < 1e-6, 'and keeps its rest orientation and scale')
  check(maxDiff(before.get('head'), after.get('head')) < 1e-6,
    'its child does not ride along -- moving a hip must not drag the foot', maxDiff(before.get('head'), after.get('head')).toExponential(1))
  check(maxDiff(before.get('tail'), after.get('tail')) < 1e-6, 'and an unrelated joint does not stir')

  // This is the check the whole feature rests on. The joint pivots somewhere
  // new, but the mesh at rest is untouched, because the inverse bind matrix
  // moved with it.
  check(restResidual(json, report.bin) < 1e-5, 'the rest pose is unchanged, so the skin does not tear', restResidual(json, report.bin).toExponential(1))
  check(report.repositioned.length === 1 && report.repositioned[0].startsWith('chest ->'), 'the report says what moved and where')
  check(report.bin.length > bin.length, 'the rebuilt inverse bind matrices are appended to the BIN chunk')
  check(json.buffers[0].byteLength === report.bin.length, 'and the buffer declares its new length', `${json.buffers[0].byteLength}`)

  const untouched = skinnedRig()
  const plain = readAccessor(untouched.json, untouched.bin, 2)
  const edited = readAccessor(json, report.bin, json.skins[0].inverseBindMatrices)
  check(maxDiff([...plain.slice(0, 16)], [...edited.slice(0, 16)]) < 1e-6, 'a joint that did not move keeps the inverse bind matrix it was authored with')
  check(maxDiff([...plain.slice(16, 32)], [...edited.slice(16, 32)]) > 0.01, 'and the one that moved does not')
}

console.log('\nadding a joint the chain stopped short of')
{
  // Positions for the fixture's three vertices: v1 sits 15 cm over the head joint, the others nowhere near it.
  const withPositions = () => {
    const { json, bin } = skinnedRig()
    const head = worlds(json).get('head').slice(9)
    const pos = new Float32Array([0, 0, 0, head[0], head[1] + 0.15, head[2], 1, 1, 1])
    const grown = Buffer.concat([bin, Buffer.from(pos.buffer)])
    json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: 36 })
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: 3, type: 'VEC3' })
    json.meshes[0].primitives[0].attributes.POSITION = json.accessors.length - 1
    json.buffers[0].byteLength = grown.length
    return { json, bin: grown, head }
  }
  const { json, bin, head } = withPositions()
  const weightBefore = totalWeight(json, bin)
  const at = [head[0], head[1] + 0.1, head[2]]
  const report = applyRigEdit(json, { add: { hand: { parent: 'head', at } } }, bin)

  const after = worlds(json)
  check(report.added.length === 1 && report.added[0].startsWith('hand under head'), 'the report names the joint and its parent', report.added.join())
  check(maxDiff(after.get('hand').slice(9), at) < 1e-6, 'the new joint lands where it was told to')
  check(json.nodes.find((n) => n.name === 'head').children.includes(json.nodes.findIndex((n) => n.name === 'hand')), 'and hangs off its parent')
  check(json.skins[0].joints.length === 5 && json.nodes[json.skins[0].joints[4]].name === 'hand', 'it is the skin\'s last joint')
  const joints = [...readAccessor(json, report.bin, 0)]
  const weights = [...readAccessor(json, report.bin, 1)]
  check(joints.slice(4, 8).includes(4) && Math.abs(weights[4 + joints.slice(4, 8).indexOf(4)] - 0.5) < 1e-6 && joints.slice(4, 8).includes(1), 'a vertex past the plane hands the parent\'s weight to it and keeps its other influence', `${joints.slice(4, 8)} @ ${weights.slice(4, 8)}`)
  check(!joints.slice(0, 4).includes(4) && !joints.slice(8, 12).includes(4), 'and a vertex short of it is left alone')
  check(Math.abs(totalWeight(json, report.bin) - weightBefore) < 1e-6, 'no weight is created or lost', `${totalWeight(json, report.bin).toFixed(4)} vs ${weightBefore.toFixed(4)}`)
  check(restResidual(json, report.bin) < 1e-5, 'the rest pose is still the identity', restResidual(json, report.bin).toExponential(1))
  const off = withPositions()
  check(throws(() => applyRigEdit(off.json, { add: { hand: { parent: 'head', at: [5, 5, 5] } } }, off.bin)), 'a joint placed off the mesh, taking no vertex, is refused')
  const again = withPositions()
  check(throws(() => applyRigEdit(again.json, { add: { chest: { parent: 'head', at } } }, again.bin)), 'a name the glb already has is refused')
}

console.log('\ndeleting and moving together')
{
  const { json, bin } = skinnedRig()
  const before = worlds(json)
  const report = applyRigEdit(json, {
    delete: ['chest'],
    moves: { spine: [0, 0.62, 0] },
    reparent: { tail: 'head' },
    renames: { spine: 'Spine', head: 'Head' },
  }, bin)
  const after = worlds(json)
  check(maxDiff(after.get('Spine').slice(9), [0, 0.62, 0]) < 1e-6, 'a move, a delete, a reparent and a rename land in one pass')
  check(maxDiff(before.get('head'), after.get('Head')) < 1e-6,
    'the child of the moved joint stays put even though its own parent was deleted', maxDiff(before.get('head'), after.get('Head')).toExponential(1))
  check(maxDiff(before.get('tail'), after.get('tail')) < 1e-6, 'and the reparented joint holds its pose')
  check(restResidual(json, report.bin) < 1e-5, 'the rest pose survives all four at once', restResidual(json, report.bin).toExponential(1))
  check(report.deleted.length === 1 && report.moved.length === 1 && report.renamed.length === 2 && report.repositioned.length === 1, 'and the report counts each kind')
}

console.log('\ndeletes and moves that must be refused')
{
  const skinned = () => skinnedRig()
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['root'] }, f.bin) }), 'deleting a joint with nothing above it to inherit its children')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['body'] }, f.bin) }), 'deleting a node that carries the mesh')
  check(message(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['body'] }, f.bin) }).includes('geometry'), 'and the error says why')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['chest'], moves: { chest: [0, 0, 0] } }, f.bin) }), 'moving a joint the same edit deletes')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['chest'], reparent: { head: 'chest' } }, f.bin) }), 'parenting to a joint the same edit deletes')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: ['chest'], renames: { chest: 'Torso' } }, f.bin) }), 'renaming a joint the same edit deletes')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { moves: { chest: [0, 'up', 0] } }, f.bin) }), 'a move that is not three numbers')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { moves: { chest: [0, 1, 0] } }) }), 'a move with no BIN chunk to rebind against')
  check(message(() => { const f = skinned(); applyRigEdit(f.json, { moves: { chest: [0, 1, 0] } }) }).includes('BIN'), 'and the error says what is missing')
  check(throws(() => { const f = skinned(); applyRigEdit(f.json, { delete: 'chest' }, f.bin) }), 'a delete list that is not a list')
}

// --- the vocabulary ---------------------------------------------------------

console.log('\nthe Mixamo skeleton')
{
  const orphans = Object.entries(HIERARCHY).filter(([name, parent]) => parent !== null && !(parent in HIERARCHY))
  check(orphans.length === 0, 'every bone names a parent that is also in the list', orphans.map(([n]) => n).join(' '))
  check(Object.values(HIERARCHY).filter((p) => p === null).length === 1, 'there is exactly one root')
  const cycles = Object.keys(HIERARCHY).filter((name) => {
    let steps = 0
    for (let b = name; b; b = HIERARCHY[b]) if (++steps > Object.keys(HIERARCHY).length) return true
    return false
  })
  check(cycles.length === 0, 'and no bone is its own ancestor')
  check([...REQUIRED].every((name) => name in HIERARCHY), 'every required bone exists in the hierarchy')
  const lopsided = [...REQUIRED].filter((n) => n.startsWith('Left') && !REQUIRED.has(`Right${n.slice(4)}`))
  check(lopsided.length === 0, 'and every required bone on the left has its mirror on the right', lopsided.join(' '))
  // Mixamo's side is a prefix word, never a `.L` suffix: one stray `.L` and a
  // clip's tracks stop binding, silently, on that limb alone.
  const suffixed = Object.keys(HIERARCHY).filter((n) => /\.[LR]$/.test(n))
  check(suffixed.length === 0, 'no bone uses a .L / .R suffix instead of the prefix word', suffixed.join(' '))

  check(descends('LeftForeArm', 'Spine2') && !descends('LeftForeArm', 'Tail'), 'descends() walks the chain')
  check(descends('Tail3', 'Hips') && !descends('Hips', 'Tail3'), 'and only in the one direction')
  // The asymmetry that catches people: legs off the pelvis, arms off the ribcage.
  check(descends('LeftUpLeg', 'Hips') && !descends('LeftUpLeg', 'Spine'), 'legs hang off Hips, not off the spine')
  check(descends('LeftShoulder', 'Spine2'), 'and arms hang off Spine2')

  // The required set deliberately skips Neck1, so a rig that fills only what is
  // required must still resolve to a connected hierarchy.
  check(expectedParent('Head', REQUIRED) === 'Neck', 'a bone whose canonical parent is unfilled falls back to the nearest one that is', expectedParent('Head', REQUIRED))
  check(expectedParent('Hips', REQUIRED) === null, 'and the root has no parent to fall back to')
  const unreachable = [...REQUIRED].filter((n) => n !== 'Hips' && expectedParent(n, REQUIRED) === null)
  check(unreachable.length === 0, 'so every required bone still reaches the root', unreachable.join(' '))
}

console.log('\nthe Quaternius preview mapping')
{
  const strays = Object.entries(QUATERNIUS_TO_MIXAMO).filter(([, to]) => !(to in HIERARCHY))
  check(strays.length === 0, 'every mapped name is a bone this vocabulary has', strays.map(([f, t]) => `${f}->${t}`).join(' '))
  const targets = Object.values(QUATERNIUS_TO_MIXAMO)
  const collisions = targets.filter((t, i) => targets.indexOf(t) !== i)
  // Two source joints driving one target would leave whichever bound last in
  // charge, which is a silently half-played clip rather than an error.
  check(collisions.length === 0, 'and no two source joints drive the same one', [...new Set(collisions)].join(' '))
  // Every limb joint a walk needs has a source. The pack's spine is one joint
  // shorter than ours between the pelvis and the chest, so Spine1 rides at rest
  // -- the one gap, and it is named here so a wider one cannot open unnoticed.
  const undriven = [...REQUIRED].filter((n) => !targets.includes(n))
  check(undriven.join(' ') === 'Spine1', 'the only required bone the pack cannot drive is the spare spine joint', undriven.join(' '))
}

console.log(`\n${failures === 0 ? 'all rig-edit checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
