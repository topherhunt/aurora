import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { cullTripoBackfaces } from './tripo-culling.js'
import { BONES, HIERARCHY, REQUIRED, expectedParent } from '../tools/creatures/quadruped-rig.mjs'

// ---------------------------------------------------------------------------
// rig-edit.html: relabel, reparent, delete and move the joints of a generated
// skeleton until it speaks the canonical quadruped vocabulary, then watch a
// real animal's walk play on it.
//
// The edit is a sidecar of names -- tools/creatures/apply-rig-edit.mjs is what
// turns it into a glb, and scripts/check-rig-edit.mjs is what holds it honest.
// Whatever is done here, the skin Tripo solved for survives: renaming and
// reparenting leave every world transform alone, deleting hands a joint's
// weights to the joint above it, and moving rebinds the joint so the mesh at
// rest does not budge -- which is why editing this rig beats building a
// skeleton from scratch, where the skin weights would be ours to solve.
//
// Two naming traps, both of which will waste an afternoon if forgotten:
//
//   GLTFLoader SANITIZES node names -- it strips `.`, `:`, `[`, `]`, `/` and
//   turns spaces into underscores -- and keeps the real one in userData.name.
//   So `tripo::Head_0` on disk is `tripoHead_0` in the scene graph. The sidecar
//   must be keyed by the ON-DISK name or apply-rig-edit cannot find the node.
//
//   The same sanitizing hits the Quaternius clips: their tracks address
//   `FrontShoulderL`, not `FrontShoulder.L`. Rather than reimplement three's
//   rule, the retarget looks each track's node up in the source scene and reads
//   its true name back off userData.
// ---------------------------------------------------------------------------

const PACK = '/tmp/Quaternius Animated Animals/glTF'
const PACK_ANIMALS = ['Alpaca', 'Bull', 'Cow', 'Deer', 'Donkey', 'Fox', 'Horse', 'Horse_White', 'Husky', 'ShibaInu', 'Stag', 'Wolf']

const viewsEl = document.getElementById('views')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.setScissorTest(true)
viewsEl.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const grid = new THREE.GridHelper(4, 8, 0x2b4a72, 0x16233a)
scene.add(grid)

const status = document.getElementById('status')
const setStatus = (text, cls) => { status.textContent = text; status.className = `note ${cls || ''}` }

// A throw inside a click handler leaves the whole panel looking merely
// unresponsive, which is the most expensive kind of bug on a bench like this.
// Put it where it can be read without opening devtools.
addEventListener('error', (e) => setStatus(`crashed: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`, 'bad'))
addEventListener('unhandledrejection', (e) => setStatus(`crashed: ${e.reason?.message ?? e.reason}`, 'bad'))

// --- the three viewports ----------------------------------------------------

const views = [...viewsEl.querySelectorAll('.vp')].map((el) => {
  const kind = el.dataset.view
  const camera = kind === 'persp'
    ? new THREE.PerspectiveCamera(40, 1, 0.01, 200)
    : new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 200)
  // Looking straight down -Y makes the default up of +Y degenerate. -Z puts the
  // animal's length up the screen and +X to the right, which is the same
  // left-to-right sense the side view has.
  if (kind === 'top') camera.up.set(0, 0, -1)
  const controls = new OrbitControls(camera, el)
  controls.enableDamping = kind === 'persp'
  // The ortho views earn their place by being axis-aligned: a drag there moves
  // in exactly two axes, which is what makes a joint's position readable and a
  // joint drag predictable. Left-drag pans rather than orbits, since an orbited
  // ortho view is no longer the axis-aligned thing it is here to be.
  controls.enableRotate = kind === 'persp'
  if (kind !== 'persp') controls.mouseButtons.LEFT = THREE.MOUSE.PAN
  controls.screenSpacePanning = true
  return { el, kind, camera, controls, labels: el.querySelector('.labels') }
})

let orthoHalf = 1

function frame(center, span) {
  for (const v of views) {
    v.controls.target.copy(center)
    if (v.kind === 'persp') {
      v.camera.position.copy(center).add(new THREE.Vector3(span * 1.4, span * 0.6, span * 1.8))
      v.camera.near = span / 100
      v.camera.far = span * 50
    } else {
      const away = v.kind === 'side' ? new THREE.Vector3(span * 3, 0, 0) : new THREE.Vector3(0, span * 3, 0)
      v.camera.position.copy(center).add(away)
      v.camera.zoom = 1
    }
    v.camera.lookAt(center)
    v.camera.updateProjectionMatrix()
    v.controls.update()
  }
  orthoHalf = span * 0.7
  resize()
}

function resize() {
  const rect = viewsEl.getBoundingClientRect()
  renderer.setSize(rect.width, rect.height, false)
  for (const v of views) {
    const r = v.el.getBoundingClientRect()
    const aspect = r.width / Math.max(r.height, 1)
    if (v.kind === 'persp') {
      v.camera.aspect = aspect
    } else {
      v.camera.left = -orthoHalf * aspect
      v.camera.right = orthoHalf * aspect
      v.camera.top = orthoHalf
      v.camera.bottom = -orthoHalf
    }
    v.camera.updateProjectionMatrix()
  }
}
addEventListener('resize', resize)

// --- the rig ----------------------------------------------------------------

const gltfLoader = new GLTFLoader()
let root = null
let bones = []
let skinned = []
let span = 1

/** The name this joint has on disk, which is what the sidecar is keyed by. */
const diskName = (bone) => bone.userData.name ?? bone.name

// Every key is a disk name. This is the whole document the page edits.
let edit = { renames: {}, reparent: {}, delete: [], moves: {} }
// The same set as edit.delete, held as bones so picking and drawing can ask.
let gone = new Set()

/** The nearest joint above this one that the edit keeps, or null. */
function survivor(bone) {
  for (let a = bone.parent; a && a.isBone; a = a.parent) if (!gone.has(a)) return a
  return null
}

// --- the chain --------------------------------------------------------------
//
// Not SkeletonHelper: it draws the scene graph, and the point of a delete is
// that the graph on disk will no longer have that link in it. Each surviving
// joint is drawn to the nearest surviving joint above it, so a deleted joint's
// children visibly join up to the one that will adopt them.

const chain = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x6fa8dc, depthTest: false, transparent: true, opacity: 0.9 }),
)
chain.renderOrder = 9
chain.frustumCulled = false
scene.add(chain)

function drawChain() {
  const position = chain.geometry.getAttribute('position')
  let at = 0
  for (const bone of bones) {
    if (gone.has(bone)) continue
    const parent = survivor(bone)
    if (!parent) continue
    bone.getWorldPosition(worldAt)
    position.setXYZ(at++, worldAt.x, worldAt.y, worldAt.z)
    parent.getWorldPosition(worldAt)
    position.setXYZ(at++, worldAt.x, worldAt.y, worldAt.z)
  }
  chain.geometry.setDrawRange(0, at)
  position.needsUpdate = true
}

async function loadRig(id) {
  setStatus(`loading ${id}...`)
  let gltf
  try {
    gltf = await gltfLoader.loadAsync(`/tools/creatures/work/${id}/rig.glb`)
  } catch (e) {
    setStatus(`no rig for "${id}" -- ${e.message}`, 'bad')
    return
  }
  let saved = { renames: {}, reparent: {}, delete: [], moves: {} }
  try {
    const res = await fetch(`/__creature-rig-edit?id=${encodeURIComponent(id)}`)
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    saved = body.edit
  } catch (e) {
    setStatus(`loaded the rig but not its sidecar -- ${e.message}`, 'warn')
  }

  if (root) scene.remove(root)
  stopPreview()
  root = cullTripoBackfaces(gltf.scene)
  scene.add(root)

  // The rig stays exactly where the glb puts it, so a joint's world position is
  // the number the sidecar wants. The ground moves to the model instead.
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  span = Math.max(size.x, size.y, size.z)
  grid.position.y = box.min.y
  grid.scale.setScalar(span / 2)
  frame(box.getCenter(new THREE.Vector3()), span)

  bones = []
  skinned = []
  root.traverse((o) => {
    if (o.isBone) bones.push(o)
    if (o.isSkinnedMesh) skinned.push(o)
  })
  // Captured before the sidecar is replayed, so "clear edits" has somewhere to
  // put a joint back.
  root.updateMatrixWorld(true)
  for (const b of bones) {
    b.userData.origParent = b.parent
    b.userData.origWorld = b.getWorldPosition(new THREE.Vector3())
  }
  chain.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bones.length * 6), 3))
  buildHandles()
  applyView()

  edit = { renames: {}, reparent: {}, delete: [], moves: {} }
  gone = new Set()
  selected = null
  try {
    replayEdit(saved)
    const counts = `${Object.keys(edit.renames).length} renames, ${Object.keys(edit.reparent).length} reparents, ${edit.delete.length} deletes, ${Object.keys(edit.moves).length} moves`
    setStatus(`${id}: ${bones.length} joints, ${counts} on file`)
  } catch (e) {
    setStatus(`the sidecar does not fit this rig -- ${e.message}`, 'bad')
  }
  paint()
}

/**
 * Put a sidecar back onto the live scene, one operation at a time. Deletes go
 * first because they decide what a reparent is even allowed to name, and moves
 * are absolute world positions, so they do not care what ran before them.
 */
function replayEdit(saved) {
  for (const name of saved.delete ?? []) remove(byDiskName(name))
  for (const [child, parent] of Object.entries(saved.reparent ?? {})) reparent(byDiskName(child), byDiskName(parent))
  for (const [name, at] of Object.entries(saved.moves ?? {})) moveTo(byDiskName(name), new THREE.Vector3(...at))
  for (const [from, to] of Object.entries(saved.renames ?? {})) rename(byDiskName(from), to)
}

function byDiskName(name) {
  const bone = bones.find((b) => diskName(b) === name)
  if (!bone) throw new Error(`the sidecar names "${name}", which this rig does not have`)
  return bone
}

// --- joint handles and picking ----------------------------------------------

const handleGeometry = new THREE.SphereGeometry(1, 12, 8)
const handleMaterials = {
  idle: new THREE.MeshBasicMaterial({ color: 0x4a7fbf, depthTest: false }),
  mapped: new THREE.MeshBasicMaterial({ color: 0x6fbf73, depthTest: false }),
  hover: new THREE.MeshBasicMaterial({ color: 0xffd9a0, depthTest: false }),
  selected: new THREE.MeshBasicMaterial({ color: 0xffae42, depthTest: false }),
}
let handles = []
const handleGroup = new THREE.Group()
scene.add(handleGroup)

function buildHandles() {
  handleGroup.clear()
  handles = bones.map((bone) => {
    const h = new THREE.Mesh(handleGeometry, handleMaterials.idle)
    h.scale.setScalar(span * 0.015)
    h.renderOrder = 10
    h.userData.bone = bone
    handleGroup.add(h)
    return h
  })
  for (const v of views) {
    v.labels.replaceChildren(...bones.map(() => document.createElement('span')))
  }
}

let hovered = null
let selected = null
let pickParentMode = false

const projected = new THREE.Vector3()
const tip = document.getElementById('tip')

/**
 * The nearest joint to the cursor in screen space, within PICK_RADIUS pixels.
 *
 * Not a raycast. The handles are a fixed fraction of the model, so on a 0.7m
 * fox they are ~1cm balls and a raycast would demand near-pixel accuracy. This
 * also picks joints buried inside the body just as readily as ones on the
 * silhouette, which is the whole point of clicking dots rather than the mesh.
 */
const PICK_RADIUS = 14

function pick(view, event) {
  const r = view.el.getBoundingClientRect()
  const px = event.clientX - r.left
  const py = event.clientY - r.top
  let best = null
  let bestDistance = PICK_RADIUS
  for (const bone of bones) {
    if (gone.has(bone)) continue
    bone.getWorldPosition(projected).project(view.camera)
    if (projected.z > 1) continue
    const distance = Math.hypot((projected.x * 0.5 + 0.5) * r.width - px, (-projected.y * 0.5 + 0.5) * r.height - py)
    if (distance < bestDistance) { bestDistance = distance; best = bone }
  }
  return best
}

// --- dragging a joint -------------------------------------------------------
//
// Ortho views only, and only along their own two axes: side moves Y and Z, top
// moves X and Z. Dragging in the perspective view would mean picking a depth
// out of nowhere, which is how joints end up subtly off-axis. Neither view
// needs to know which axes are its own -- the drag runs along the camera's own
// right and up columns, so it is whatever the view is actually showing.

let drag = null
const dragRight = new THREE.Vector3()
const dragUp = new THREE.Vector3()
const dragTo = new THREE.Vector3()

for (const view of views) {
  if (view.kind === 'persp') continue
  // Capture phase: OrbitControls listens on this same element and was bound
  // first, so a bubble-phase handler would disable it one gesture too late.
  view.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    // Only the selected joint drags. Anything looser and a pan that began a few
    // pixels from a joint would quietly move it.
    const hit = pick(view, e)
    if (!hit || hit !== selected) return
    view.controls.enabled = false
    view.el.setPointerCapture(e.pointerId)
    const rect = view.el.getBoundingClientRect()
    drag = {
      view,
      bone: hit,
      from: [e.clientX, e.clientY],
      at: hit.getWorldPosition(new THREE.Vector3()),
      // Ortho: one pixel is the same distance anywhere in the view.
      scale: (view.camera.right - view.camera.left) / view.camera.zoom / rect.width,
    }
    dragRight.setFromMatrixColumn(view.camera.matrixWorld, 0)
    dragUp.setFromMatrixColumn(view.camera.matrixWorld, 1)
  }, true)
}

addEventListener('pointermove', (e) => {
  if (!drag) return
  dragTo.copy(drag.at)
    .addScaledVector(dragRight, (e.clientX - drag.from[0]) * drag.scale)
    .addScaledVector(dragUp, -(e.clientY - drag.from[1]) * drag.scale)
  moveTo(drag.bone, dragTo)
  refreshPosition()
})

addEventListener('pointerup', (e) => {
  if (!drag) return
  drag.view.el.releasePointerCapture(e.pointerId)
  drag.view.controls.enabled = true
  const bone = drag.bone
  drag = null
  if (edit.moves[diskName(bone)]) setStatus(`${bone.name} moved to ${edit.moves[diskName(bone)].map((v) => v.toFixed(3)).join(', ')}`)
  paint()
})

for (const view of views) {
  let downAt = null
  view.el.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY] })
  view.el.addEventListener('pointermove', (e) => {
    if (drag) return
    hovered = pick(view, e)
    if (hovered) {
      tip.style.display = 'block'
      tip.style.left = `${e.clientX + 12}px`
      tip.style.top = `${e.clientY + 12}px`
      const canon = HIERARCHY[hovered.name] !== undefined ? hovered.name : null
      tip.textContent = canon ? `${canon}  (${diskName(hovered)})` : diskName(hovered)
    } else {
      tip.style.display = 'none'
    }
  })
  view.el.addEventListener('pointerleave', () => { hovered = null; tip.style.display = 'none' })
  view.el.addEventListener('click', (e) => {
    // A drag that orbits or pans is not a click. Without this every camera move
    // that started on a joint would also select it.
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return
    const hit = pick(view, e)
    if (pickParentMode && hit && selected) {
      setParent(selected, hit)
      pickParentMode = false
    } else {
      selected = hit
    }
    paint()
  })
}

// --- the edits themselves ---------------------------------------------------

function rename(bone, to) {
  const from = diskName(bone)
  if (to === from) delete edit.renames[from]
  else edit.renames[from] = to
  bone.name = to
}

function reparent(bone, parent) {
  if (!parent) throw new Error('reparenting needs a target')
  for (let a = parent; a; a = a.parent) {
    if (a === bone) throw new Error(`"${bone.name}" is already above "${parent.name}" -- that would be a cycle`)
  }
  // attach() rewrites the local transform so the world transform survives,
  // which is the same arithmetic apply-rig-edit.mjs does on the file.
  parent.attach(bone)
  if (parent === bone.userData.origParent) delete edit.reparent[diskName(bone)]
  else edit.reparent[diskName(bone)] = diskName(parent)
}

function setParent(bone, parent) {
  try {
    reparent(bone, parent)
    setStatus(`${bone.name} now hangs off ${parent.name}`)
  } catch (e) {
    setStatus(e.message, 'bad')
  }
}

const scratchMatrix = new THREE.Matrix4()

/**
 * Put a joint at a world position without disturbing anything else.
 *
 * Two things have to be compensated, and both are the same rule stated twice:
 * a joint's children keep their own world transforms, so moving a hip does not
 * drag the feet along; and the joint's inverse bind matrix is recomputed, so
 * the mesh at rest is untouched and only the joint's PIVOT has changed. That
 * second one is what apply-rig-edit.mjs writes into the glb, and doing it here
 * too is the only reason the preview on this page tells the truth.
 */
function moveTo(bone, at) {
  root.updateMatrixWorld(true)
  const keep = bone.children.map((child) => [child, child.matrixWorld.clone()])

  if (bone.parent) bone.position.copy(at).applyMatrix4(scratchMatrix.copy(bone.parent.matrixWorld).invert())
  else bone.position.copy(at)
  bone.updateMatrixWorld(true)

  for (const [child, world] of keep) {
    child.matrix.multiplyMatrices(scratchMatrix.copy(bone.matrixWorld).invert(), world)
    child.matrix.decompose(child.position, child.quaternion, child.scale)
  }
  root.updateMatrixWorld(true)

  for (const mesh of skinned) {
    const slot = mesh.skeleton.bones.indexOf(bone)
    if (slot >= 0) mesh.skeleton.boneInverses[slot].copy(bone.matrixWorld).invert()
  }

  const key = diskName(bone)
  // A drag that lands back where it started is not an edit. Without this every
  // click on the selected joint would file a move of zero distance.
  if (bone.getWorldPosition(worldAt).distanceTo(bone.userData.origWorld) < span * 1e-5) delete edit.moves[key]
  else edit.moves[key] = [worldAt.x, worldAt.y, worldAt.z]
}

/**
 * Take a joint out of the rig. Its children join up to the joint above it and
 * its skin weights go the same way, so the animal keeps its shape -- but only
 * apply-rig-edit.mjs can do that arithmetic to the file, so what happens here
 * is the picture of it: the joint stops being drawn, and the chain is drawn
 * closed over the gap.
 */
function remove(bone) {
  if (gone.has(bone)) return
  if (!survivor(bone)) throw new Error(`nothing above "${bone.name}" survives to adopt its children`)
  const key = diskName(bone)
  const dependents = Object.entries(edit.reparent).filter(([, parent]) => parent === key)
  if (dependents.length) throw new Error(`${dependents.length} joint(s) were reparented onto "${bone.name}" -- move them elsewhere before deleting it`)
  // A delete cannot coexist with any other edit of the same joint, so undo
  // them rather than letting the save fail on the far side.
  clearEdits(bone)
  gone.add(bone)
  edit.delete.push(key)
}

function restore(bone) {
  gone.delete(bone)
  edit.delete = edit.delete.filter((name) => name !== diskName(bone))
}

function clearEdits(bone) {
  const key = diskName(bone)
  delete edit.renames[key]
  bone.name = key
  if (edit.reparent[key]) {
    bone.userData.origParent.attach(bone)
    delete edit.reparent[key]
  }
  if (edit.moves[key]) moveTo(bone, bone.userData.origWorld)
  restore(bone)
}

// --- panels -----------------------------------------------------------------

const selEl = document.getElementById('sel')
const validationEl = document.getElementById('validation')
const treeEl = document.getElementById('tree')
const editCountEl = document.getElementById('editCount')

/** disk name -> canonical name, for every joint currently carrying one. */
function assignments() {
  const out = new Map()
  for (const b of bones) if (!gone.has(b) && HIERARCHY[b.name] !== undefined) out.set(b, b.name)
  return out
}

/** The canonical name of the closest ancestor that has one, or null. */
function mappedParent(bone) {
  for (let a = bone.parent; a; a = a.parent) if (!gone.has(a) && HIERARCHY[a.name] !== undefined) return a.name
  return null
}

// The three world-position fields, kept out of paintSelection() so a drag can
// update the numbers without rebuilding the panel under the cursor.
let positionInputs = null

function refreshPosition() {
  if (!positionInputs || !selected) return
  selected.getWorldPosition(worldAt)
  const axes = [worldAt.x, worldAt.y, worldAt.z]
  positionInputs.forEach((input, i) => { if (document.activeElement !== input) input.value = axes[i].toFixed(4) })
}

function paintSelection() {
  positionInputs = null
  if (!selected) {
    selEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: 'click a joint in any view' }))
    return
  }
  const canon = HIERARCHY[selected.name] !== undefined ? selected.name : ''
  const frag = document.createDocumentFragment()
  frag.append(
    Object.assign(document.createElement('div'), { className: 'name', textContent: selected.name }),
    Object.assign(document.createElement('div'), { className: 'orig', textContent: `on disk: ${diskName(selected)}` }),
  )

  const nameRow = document.createElement('div')
  nameRow.className = 'row'
  const nameSelect = document.createElement('select')
  nameSelect.append(new Option('-- unmapped --', ''))
  const taken = new Set(bones.filter((b) => b !== selected).map((b) => b.name))
  for (const name of BONES) {
    const option = new Option(REQUIRED.has(name) ? name : `${name} (optional)`, name)
    option.disabled = taken.has(name)
    nameSelect.append(option)
  }
  nameSelect.value = canon
  nameSelect.disabled = gone.has(selected)
  nameSelect.onchange = () => {
    rename(selected, nameSelect.value || diskName(selected))
    paint()
  }
  nameRow.append(nameSelect)
  frag.append(nameRow)

  const parentRow = document.createElement('div')
  parentRow.className = 'row'
  const parentSelect = document.createElement('select')
  for (const b of bones) {
    if (b === selected) continue
    const option = new Option(b.name, diskName(b))
    parentSelect.append(option)
  }
  if (!(selected.parent && selected.parent.isBone)) {
    parentSelect.prepend(new Option(`(${selected.parent?.name ?? 'none'})`, ''))
  }
  parentSelect.value = selected.parent && selected.parent.isBone ? diskName(selected.parent) : ''
  parentSelect.onchange = () => {
    if (!parentSelect.value) return
    setParent(selected, byDiskName(parentSelect.value))
    paint()
  }
  const pickButton = document.createElement('button')
  pickButton.textContent = pickParentMode ? 'click one' : 'pick'
  pickButton.className = pickParentMode ? 'on' : ''
  pickButton.onclick = () => { pickParentMode = !pickParentMode; paint() }
  parentSelect.disabled = gone.has(selected)
  pickButton.disabled = gone.has(selected)
  parentRow.append(parentSelect, pickButton)
  frag.append(
    Object.assign(document.createElement('div'), { className: 'note', textContent: 'parent' }),
    parentRow,
  )

  const positionRow = document.createElement('div')
  positionRow.className = 'row'
  positionInputs = ['x', 'y', 'z'].map((axis) => {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = (span / 100).toFixed(4)
    input.title = axis
    input.onchange = () => {
      const at = new THREE.Vector3(...positionInputs.map((f) => Number(f.value)))
      if (at.toArray().some((v) => !Number.isFinite(v))) { setStatus('a position needs three numbers', 'bad'); return }
      moveTo(selected, at)
      paint()
    }
    positionRow.append(input)
    return input
  })
  frag.append(
    Object.assign(document.createElement('div'), { className: 'note', textContent: 'world position -- or drag the joint in the side or top view' }),
    positionRow,
  )

  const buttons = document.createElement('div')
  buttons.className = 'row'
  const remove_ = document.createElement('button')
  remove_.textContent = gone.has(selected) ? 'restore' : 'delete joint'
  remove_.className = gone.has(selected) ? 'on' : ''
  remove_.onclick = () => {
    try {
      if (gone.has(selected)) { restore(selected); setStatus(`${selected.name} is back in the rig`) }
      else { remove(selected); setStatus(`${selected.name} deleted -- its children will join up to ${survivor(selected).name}`) }
    } catch (e) {
      setStatus(e.message, 'bad')
    }
    paint()
  }
  const clear = document.createElement('button')
  clear.textContent = 'clear edits'
  clear.onclick = () => { clearEdits(selected); paint() }
  buttons.append(remove_, clear)
  frag.append(buttons)
  selEl.replaceChildren(frag)
  refreshPosition()
}

function paintValidation() {
  const assigned = new Set([...assignments().values()])
  const rows = BONES.map((name) => {
    const bone = bones.find((b) => b.name === name && !gone.has(b))
    const row = document.createElement('div')
    if (!bone) {
      row.textContent = `  ${name}`
      row.className = REQUIRED.has(name) ? 'bad' : 'unmapped'
      return row
    }
    const want = expectedParent(name, assigned)
    const have = mappedParent(bone)
    const ok = want === have
    row.textContent = `${ok ? 'v' : '!'} ${name}${ok ? '' : `   under ${have ?? '(nothing)'}, wants ${want ?? '(root)'}`}`
    row.className = ok ? 'ok' : 'warn'
    row.onclick = () => { selected = bone; paint() }
    if (bone === selected) row.classList.add('sel')
    return row
  })
  validationEl.replaceChildren(...rows)
}

function paintTree() {
  const depth = (b) => { let d = 0; for (let p = b.parent; p && p.isBone; p = p.parent) d++; return d }
  treeEl.replaceChildren(...bones.map((b) => {
    const row = document.createElement('div')
    const mapped = HIERARCHY[b.name] !== undefined
    row.textContent = `${'  '.repeat(depth(b))}${b.name}`
    row.className = gone.has(b) ? 'gone' : mapped ? '' : 'unmapped'
    if (b === selected) row.classList.add('sel')
    row.onclick = () => { selected = b; paint() }
    return row
  }))
}

function paint() {
  if (!root) return
  for (const h of handles) {
    const bone = h.userData.bone
    h.visible = !gone.has(bone)
    h.material = bone === selected ? handleMaterials.selected
      : bone === hovered ? handleMaterials.hover
      : HIERARCHY[bone.name] !== undefined ? handleMaterials.mapped
      : handleMaterials.idle
  }
  for (const v of views) {
    for (let i = 0; i < bones.length; i++) v.labels.children[i].textContent = bones[i].name
  }
  editCountEl.textContent = `${Object.keys(edit.renames).length} renamed, ${Object.keys(edit.reparent).length} reparented, ${edit.delete.length} deleted, ${Object.keys(edit.moves).length} moved`
  paintSelection()
  paintValidation()
  paintTree()
}

// --- view toggles -----------------------------------------------------------

const meshCheck = document.getElementById('showMesh')
const skeletonCheck = document.getElementById('showSkeleton')
const namesCheck = document.getElementById('showNames')
const groundCheck = document.getElementById('showGround')

function applyView() {
  root.traverse((o) => { if (o.isMesh) o.visible = meshCheck.checked })
  chain.visible = skeletonCheck.checked
  grid.visible = groundCheck.checked
  for (const v of views) v.labels.classList.toggle('on', namesCheck.checked)
}
for (const el of [meshCheck, skeletonCheck, namesCheck, groundCheck]) el.onchange = () => { if (root) applyView() }

// --- saving -----------------------------------------------------------------

const idInput = document.getElementById('creatureId')
document.getElementById('load').onclick = () => loadRig(idInput.value.trim())
document.getElementById('revert').onclick = () => loadRig(idInput.value.trim())

document.getElementById('save').onclick = async () => {
  const id = idInput.value.trim()
  setStatus('saving...')
  try {
    const res = await fetch(`/__creature-rig-edit?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    // A dev server started before deletes and moves existed strips them out of
    // the posted edit and answers without these two counts. Say so: the save it
    // just did was a partial one, and reading .length off the missing count
    // would report a type error where the real fault is a stale server.
    if (!body.deleted || !body.repositioned) {
      throw new Error('the dev server predates deletes and moves -- it saved the renames and dropped the rest. Restart it, then save again.')
    }
    setStatus(`saved: ${body.moved.length} reparented, ${body.renamed.length} renamed, ${body.deleted.length} deleted, ${body.repositioned.length} moved -- written to rig-fixed.glb`, 'ok')
  } catch (e) {
    // The page holds the only copy of an unsaved edit, and a reload loses it.
    // Put it somewhere recoverable before saying the save failed.
    console.warn('rig edit that failed to save:', JSON.stringify(edit))
    setStatus(`save refused: ${e.message} -- the full edit is in the console`, 'bad')
  }
}

// --- preview ----------------------------------------------------------------
//
// Retargeting by name, rotations only. A source track says how far a bone
// turned from ITS rest pose; that delta is replayed from OUR rest pose:
//
//   ours(t) = restOurs * inverse(restTheirs) * theirs(t)
//
// which is exact when the two skeletons hold a bone's local axes the same way
// and an approximation otherwise -- the usual one, and the reason a preview
// exists at all rather than a promise. Position tracks are dropped, so the
// body does not bob and does not travel: this answers "are the labels right",
// not "is this the final clip".

const animalSelect = document.getElementById('previewAnimal')
const clipSelect = document.getElementById('previewClip')
const playButton = document.getElementById('previewPlay')
const stopButton = document.getElementById('previewStop')
const previewNote = document.getElementById('previewNote')

animalSelect.append(...PACK_ANIMALS.map((n) => new Option(n.replace(/_/g, ' '), n)))
animalSelect.value = 'Wolf'

const packCache = new Map()
async function loadPack(name) {
  if (!packCache.has(name)) {
    const gltf = await gltfLoader.loadAsync(encodeURI(`${PACK}/${name}.gltf`))
    const byScene = new Map()
    gltf.scene.traverse((o) => { if (o.isBone) byScene.set(o.name, o) })
    packCache.set(name, { clips: gltf.animations, byScene })
  }
  return packCache.get(name)
}

async function refreshClips() {
  clipSelect.replaceChildren()
  previewNote.textContent = `loading ${animalSelect.value}...`
  try {
    const pack = await loadPack(animalSelect.value)
    clipSelect.append(...pack.clips.map((c) => new Option(c.name, c.name)))
    clipSelect.value = pack.clips.some((c) => c.name === 'Walk') ? 'Walk' : pack.clips[0].name
    previewNote.textContent = `${pack.clips.length} clips, retargeted by bone name`
  } catch (e) {
    previewNote.textContent = `no pack in tmp/ -- ${e.message}`
  }
}
animalSelect.onchange = refreshClips

let preview = null

async function startPreview() {
  if (!root) return
  const pack = await loadPack(animalSelect.value)
  const clip = pack.clips.find((c) => c.name === clipSelect.value)
  const ours = new Map(bones.map((b) => [b.name, b]))

  const bindings = []
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    if (track.name.slice(dot + 1) !== 'quaternion') continue
    const srcBone = pack.byScene.get(track.name.slice(0, dot))
    if (!srcBone) continue
    // Back to the true glTF name: the track addresses the sanitized one.
    const target = ours.get(srcBone.userData.name ?? srcBone.name)
    // A deleted joint is left at rest rather than driven, which is exactly what
    // it becomes in the file: its local transform folds into its children.
    if (!target || gone.has(target)) continue
    bindings.push({
      target,
      interpolant: track.createInterpolant(),
      restSrcInv: srcBone.quaternion.clone().invert(),
      restDst: target.quaternion.clone(),
    })
  }
  if (!bindings.length) {
    setStatus(`nothing to drive: no joint on this rig carries a name ${animalSelect.value} animates. Map some bones first.`, 'warn')
    return
  }
  preview = { bindings, duration: clip.duration, time: 0, rest: new Map(bones.map((b) => [b, b.quaternion.clone()])) }
  playButton.disabled = true
  stopButton.disabled = false
  setStatus(`playing ${clip.name} from ${animalSelect.value} on ${bindings.length} of ${bones.length} joints`, 'ok')
}

function stopPreview() {
  if (preview) for (const [bone, q] of preview.rest) bone.quaternion.copy(q)
  preview = null
  playButton.disabled = false
  stopButton.disabled = true
}

playButton.onclick = () => startPreview()
stopButton.onclick = () => { stopPreview(); setStatus('preview stopped') }

// --- run --------------------------------------------------------------------

const labelAt = new THREE.Vector3()
const worldAt = new THREE.Vector3()
const scratchQuat = new THREE.Quaternion()

function drawLabels(view, rect) {
  if (!namesCheck.checked) return
  for (let i = 0; i < bones.length; i++) {
    const el = view.labels.children[i]
    if (gone.has(bones[i])) { el.style.display = 'none'; continue }
    bones[i].getWorldPosition(labelAt).project(view.camera)
    if (labelAt.z > 1) { el.style.display = 'none'; continue }
    el.style.display = ''
    el.style.left = `${(labelAt.x * 0.5 + 0.5) * rect.width}px`
    el.style.top = `${(-labelAt.y * 0.5 + 0.5) * rect.height}px`
  }
}

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()

  if (preview) {
    preview.time = (preview.time + dt) % preview.duration
    for (const b of preview.bindings) {
      const [x, y, z, w] = b.interpolant.evaluate(preview.time)
      b.target.quaternion.copy(b.restDst).multiply(b.restSrcInv).multiply(scratchQuat.set(x, y, z, w))
    }
  }

  for (const v of views) v.controls.update(dt)
  if (root) {
    root.updateMatrixWorld(true)
    for (const h of handles) {
      h.userData.bone.getWorldPosition(worldAt)
      h.position.copy(worldAt)
    }
    drawChain()
  }

  const outer = viewsEl.getBoundingClientRect()
  for (const v of views) {
    const r = v.el.getBoundingClientRect()
    const x = r.left - outer.left
    const y = outer.bottom - r.bottom
    renderer.setViewport(x, y, r.width, r.height)
    renderer.setScissor(x, y, r.width, r.height)
    renderer.render(scene, v.camera)
    drawLabels(v, r)
  }
})

resize()
refreshClips()
loadRig(idInput.value.trim())
