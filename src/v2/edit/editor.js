import * as THREE from 'three'

import { WORLD_HALF, WORLD_SIZE } from '../config.js'
import { Gizmo } from './gizmo.js'
import { History } from './history.js'
import { raymarchGround, screenRay, pointerNdc } from './pick.js'
import { gizmoFromLake, lakeFromGizmo, MIN_LAKE_RADIUS } from './lake-transform.js'
import { restoreLayers } from './restore.js'
import { rebindIndex, pathPointPos, snowPointPos } from './handles.js'
import { saveLocal } from './persist.js'

// ---------------------------------------------------------------------------
// The v2 editing tool state machine (§18 "Editing").
//
// One object owns: which tool is armed, what is selected, the gizmo attached to
// it, the in-progress spline, the undo stack, and the debounce between an edit
// and a remesh. The host forwards raw pointer and key events and gets a `dirty
// rect` callback back; it does not know about tools.
//
// FOUR THINGS IN HERE ARE NOT OBVIOUS AND ARE WORTH READING BEFORE CHANGING:
//
// PICKING GOES THROUGH THE FIELD, NOT THE MESH. Every terrain click is
// `raymarchGround`, for the reasons written at the top of pick.js -- the mesh
// under the cursor is whatever LOD the streamer happens to have there.
//
// CLICK IS NOT POINTERDOWN. Mouse-look starts on the same button on the same
// canvas, so a press that MOVES is a camera drag and must not also place a
// river point. A press is a click only if it comes up within DRAG_SLOP pixels
// of where it went down. Without that, looking around while the river tool is
// armed litters the world with control points.
//
// THE GIZMO GETS FIRST REFUSAL. TransformControls installs its own pointerdown
// listener on the same canvas (see gizmo.js), so both it and this class see
// every press. `gizmo.overHandle` is checked first and the press is dropped:
// otherwise reaching for the translate arrow while the lake tool is armed
// creates a lake under the arrow at the same time as dragging it.
//
// UNDO RESTORES INTO THE LIVE `Layers`. See restore.js -- `Layers.deserialize`
// returns a new instance and half the engine holds a reference to the old one.
//
// KEY CONFLICT, KNOWN AND DELIBERATE: `S` is walk-backward in the host's
// movement code and scale-mode in Blender's muscle memory, which §18 asked for
// by name. The resolution here is that G/R/S are consumed ONLY while a gizmo is
// attached -- with nothing selected, S still walks. `onKeyDown` returns true
// when it consumed the key, and the host must not act on it in that case.
// ---------------------------------------------------------------------------

export const TOOLS = ['select', 'snowline', 'lake', 'river', 'road']
// Digits, not letters. G/R/S/X/Y/Z are spoken for by the gizmo and WASD by the
// player, which leaves no mnemonic letters that are not already load-bearing.
export const TOOL_KEYS = ['1', '2', '3', '4', '5']

const SELECTABLE = ['snow', 'lake', 'river', 'road']

// ---------------------------------------------------------------------------
// THE EDITOR AND THE MARKER LAYER NAME HANDLES DIFFERENTLY, and the two shapes
// have to be translated rather than assumed equal.
//
// Markers has one InstancedMesh per GEOMETRY, so its kinds are snow / spline /
// lake -- a river point and a road point are the same bead and live in the same
// mesh. Its snow records carry the literal id 'snow' (a snow point has no id in
// the document) and its lake records carry index 0.
//
// The editor selects by DOCUMENT identity: kind river or road, so the context
// panel can name the thing and the tools can tell one from the other; id null
// for a snow point; index null for a whole lake or a whole path.
//
// Handing one vocabulary to the other throws -- setHighlight rejects an unknown
// kind -- which is the good case. The quiet one is the id and index mismatch:
// setHighlight compares all three fields to decide which instance to light up,
// so ('lake', 'l3', null) against a record of ('lake', 'l3', 0) selects nothing
// at all and simply draws no highlight.
// ---------------------------------------------------------------------------

function markerHandle(kind, id, index) {
  if (kind === 'snow') return { kind: 'snow', id: 'snow', index }
  if (kind === 'lake') return { kind: 'lake', id, index: 0 }
  return { kind: 'spline', id, index }
}

// §18: "a drag must be one remesh per frame-ish, not one per mousemove". 120 ms
// is eight remeshes a second, which reads as continuous while leaving the worker
// most of its time for the chunks the drag actually invalidated.
const DIRTY_MS = 120

// Pixels. Below a typical mouse's hand jitter, well under any deliberate look.
const DRAG_SLOP = 4
const DOUBLE_CLICK_MS = 350

// §18 "Placement is one click on the terrain". delta 0 means the new point
// starts ON the global line, so placing one changes nothing until it is dragged
// -- placement and authoring stay separate gestures.
const SNOW_DELTA = 0

// A snow-line control point should shape ONE mountain flank, which is a fraction
// of the world rather than a fixed number of metres. DERIVED, because the world
// box has now been restated twice mid-build (16384 -> 4096 -> 8192) and a typed
// literal was wrong both times: 400 m was 1/40 of the 16 km draft, so 1/40 is
// the number that carries the intent. At WORLD_SIZE 8192 that is 204.8 m.
const SNOW_RADIUS = WORLD_SIZE / 40

// A lake's size is physical rather than world-relative, so this is a literal --
// but halved from the 16 km draft's 40 m along with the world, because the
// default is not really "how big is a pond", it is "how big a thing do you want
// to have to drag OUTWARD", and that is a fraction of what you can see. 20 m of
// radius is a 40 m pond: visible from the shore you clicked on, and small enough
// that growing it reads as authoring where shrinking one reads as fixing.
const LAKE_DEFAULTS = { rx: 20, rz: 20, rot: 0, shape: 0, carve: 1, depth: 8 }
const LAKE_LIFT = 1 // §18: "y = groundY + 1" -- the water sits just above the hit
const PATH_WIDTH = { river: 8, road: 6 } // metres of real river and real road; nothing to rescale

// The widest a path may be made before it should have been a lake instead. A
// six-lane motorway is about 30 m; 64 m is twice that and past the point where a
// swept spline is the right primitive at all.
const PATH_WIDTH_MAX = 64

// The preview polyline is lifted off the ground so it is not in a z-fight with
// the terrain it traces. 0.4 m is under a step and over any LOD disagreement.
const PREVIEW_LIFT = 0.4
const PREVIEW_MAX_VERTS = 512

const CURSOR_MS = 250 // the cursor readout repaints with the panel, at 4 Hz

export class Editor {
  constructor({ scene, camera, renderer, layers, height, markers, onDirty, orbitLock, elevation }) {
    if (typeof onDirty !== 'function') throw new Error('Editor: onDirty(rect) is required')
    if (typeof orbitLock !== 'function') throw new Error('Editor: orbitLock(bool) is required')
    if (typeof layers.takeDirtyRect !== 'function') throw new Error('Editor: layers does not look like a v2 Layers')
    if (typeof markers.hitTest !== 'function') throw new Error('Editor: markers does not look like a v2 Markers')

    // ELEVATION RANGES ARE NOT CONSTANTS IN THIS FILE, and that is the whole
    // point of this block. Every metres-above-sea number the panel offers -- a
    // lake's water level, a snow-line delta, a carve depth -- is a fraction of
    // the world's VERTICAL extent, and v2 no longer knows that extent: the
    // coarse shape is an imported 8-bit JPEG carrying no metres, and its
    // min/max are chosen at bake time and written into world/height.json. A
    // range hardcoded here would be right for exactly one bake and would then
    // put the top of the mountain outside a slider, silently, with no error to
    // notice. So the host must say, and there is no default to fall back to.
    if (elevation) {
      const { min, max } = elevation
      if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
        throw new Error(`Editor: elevation must be {min, max} in metres with max > min, got ${JSON.stringify(elevation)}`)
      }
      this.elevation = { min, max }
    } else if (Number.isFinite(height.minY) && Number.isFinite(height.maxY)) {
      this.elevation = { min: height.minY, max: height.maxY }
    } else {
      throw new Error(
        'Editor: no elevation range. Pass {elevation: {min, max}} from the loaded heightmap meta (world/height.json), or expose minY/maxY on V2Height. Hardcoding a range here would put half the mountain outside every slider the next time the heightmap is re-baked.'
      )
    }

    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.layers = layers
    this.height = height
    this.markers = markers
    this.onDirty = onDirty

    this.tool = 'select'
    this.active = false
    this.selection = null
    this.draft = null // {kind, width, pts: [[x,y,z,w],...], cursor: {x,y,z}|null}
    this.cursor = null // last ground point under the pointer, for the panel readout
    this.error = '' // last thing that went wrong, shown by the panel

    // Visibility is editor-local: nothing on the Layers contract hides an
    // object, because hiding is a render decision and the document is the
    // authored truth. The host reads this set when it builds water and road
    // surfaces; the markers layer reads it through `markers.sync()`.
    this.hidden = new Set()

    this.gizmo = new Gizmo({ scene, camera, domElement: renderer.domElement, orbitLock })
    this.gizmo.onChange(() => this._onGizmoChange())
    this.gizmo.onCommit(() => this._onGizmoCommit())

    this.history = new History(64)
    this.history.reset(this.snapshot())

    // An empty Object3D standing in for whatever is selected. TransformControls
    // requires its target to be in the scene graph, and none of the things this
    // editor moves are Object3Ds at all -- a snow point is four numbers in an
    // array. The proxy is the adapter.
    this.proxy = new THREE.Object3D()
    this.proxy.name = 'v2-gizmo-proxy'
    scene.add(this.proxy)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREVIEW_MAX_VERTS * 3), 3))
    geo.setDrawRange(0, 0)
    this.preview = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0x7fd1ff, depthTest: false, transparent: true, opacity: 0.9 })
    )
    this.preview.renderOrder = 998
    this.preview.frustumCulled = false
    this.preview.visible = false
    scene.add(this.preview)

    this._raycaster = new THREE.Raycaster()
    this._pointer = new THREE.Vector2()
    this._euler = new THREE.Euler()
    this._dragBase = null // the lake record as of the current drag's start
    this._down = null
    this._lastClickAt = 0
    this._ndc = null
    this._pending = false
    this._lastDirty = 0
    this._cursorAt = 0
  }

  // --- lifecycle ------------------------------------------------------------

  setActive(on) {
    this.active = Boolean(on)
    if (!this.active) {
      this.cancelDraft()
      this.deselect()
      this.cursor = null
    }
  }

  setTool(name) {
    if (!TOOLS.includes(name)) throw new Error(`Editor.setTool: unknown tool ${name}`)
    if (this.draft && name !== this.draft.kind) this.cancelDraft()
    this.tool = name
  }

  snapshot() {
    return JSON.stringify(this.layers.serialize())
  }

  /** Serialised byte count -- the panel prints it, because §18's compactness claim is worth showing rather than asserting. */
  get bytes() {
    return this.snapshot().length
  }

  // --- selection ------------------------------------------------------------

  select(kind, id, index) {
    if (!SELECTABLE.includes(kind)) throw new Error(`Editor.select: unknown kind ${kind}`)
    this.selection = { kind, id, index }
    const m = markerHandle(kind, id, index)
    this.markers.setHighlight(m.kind, m.id, m.index)
    this._attachGizmo()
  }

  deselect() {
    this.selection = null
    this._dragBase = null
    this.markers.setHighlight(null, null, null)
    this.gizmo.detach()
  }

  deleteSelected() {
    const sel = this.selection
    if (!sel) return false
    return this.removeAt(sel.kind, sel.id, sel.index)
  }

  /**
   * Remove an authored object, or one control point of one, WITHOUT requiring it
   * to be selected first: the panel's layer list deletes rows the user is not
   * working on and should not have to clobber the selection to do it.
   *
   * The selection is re-resolved by POSITION rather than by index, because an
   * index is only an identity for as long as nothing renumbers the list it
   * points into. See handles.js.
   */
  removeAt(kind, id, index) {
    if (!SELECTABLE.includes(kind)) throw new Error(`Editor.removeAt: unknown kind ${kind}`)
    const sel = this.selection
    const rebind = this._holdPointHandle()
    let removedSelection = sel !== null && sel.kind === kind && sel.id === id && sel.index === index

    if (kind === 'snow') {
      this.layers.removeSnowPoint(index)
    } else if (kind === 'lake') {
      this.layers.removeLake(id)
    } else if (index === null) {
      this.layers.removePath(id)
      removedSelection = sel !== null && sel.id === id // its points went with it
    } else {
      // Two points is the minimum that is still a line. Deleting one of the last
      // two leaves a spline that carves a single point of nothing, so the whole
      // path goes instead -- which is also what the user meant.
      // The LIVE count, not pts.length: pts carries a null tombstone for every
      // point already removed, so the raw length says four for a path that has
      // two points left and the guard below would never fire.
      if (this._pathCount(id) <= 2) {
        this.layers.removePath(id)
        removedSelection = sel !== null && sel.id === id
      } else {
        this.layers.removePathPoint(id, index)
      }
    }

    if (removedSelection) this.deselect()
    else rebind()
    this._commit()
    return true
  }

  // Visibility is EDITOR-LOCAL and currently cosmetic. `Layers` has no hidden
  // flag and `Markers.sync()` reads the document directly, so this set records
  // what the author asked for and nothing downstream reads it yet. It is keyed
  // on the whole handle -- a snow point has no id, only an index -- so the two
  // sides cannot disagree about what a row addresses.
  setVisible(kind, id, index, visible) {
    const key = `${kind}:${id}:${index}`
    if (visible) this.hidden.delete(key)
    else this.hidden.add(key)
    this.markers.sync()
  }

  isVisible(kind, id, index) {
    return !this.hidden.has(`${kind}:${id}:${index}`)
  }

  // --- the frame loop -------------------------------------------------------

  /**
   * Called once per frame by the host, which must NOT also call
   * `markers.update()` -- the marker layer's screen-space handle scaling is
   * driven from here so it cannot run twice or, worse, once with a stale camera.
   */
  update(dt, camera) {
    this.markers.update(camera)
    if (!this.active) return

    this._flushDirty(false)

    // One ground pick per frame at most, never one per mousemove: a pick is
    // ~600 heightAt calls (pick.js measures it) and a mousemove arrives far more often
    // than a frame does.
    if (this.draft && this._ndc) {
      const hit = this._pickNdc()
      if (hit) {
        this.draft.cursor = hit
        this._repaintPreview()
      }
    } else if (this._ndc) {
      const now = performance.now()
      if (now - this._cursorAt >= CURSOR_MS) {
        this._cursorAt = now
        this.cursor = this._pickNdc()
      }
    }
  }

  // --- input ----------------------------------------------------------------

  onPointerDown(ev) {
    if (!this.active || ev.button !== 0) return
    if (this.gizmo.overHandle) {
      this._down = null // the gizmo's own listener owns this press -- see the header
      return
    }
    this._down = { x: ev.clientX, y: ev.clientY }
  }

  onPointerMove(ev) {
    if (!this.active) return
    this._ndc = pointerNdc(ev, this.renderer.domElement)
  }

  onPointerUp(ev) {
    if (!this.active || ev.button !== 0) return
    const down = this._down
    this._down = null
    if (!down) return
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_SLOP) return // that was a look, not a click

    const now = performance.now()
    const isDouble = now - this._lastClickAt < DOUBLE_CLICK_MS
    this._lastClickAt = now
    this._click(ev, isDouble)
  }

  /** Returns true when the editor consumed the key and the host must ignore it. */
  onKeyDown(ev) {
    if (!this.active) return false

    if (ev.ctrlKey || ev.metaKey) {
      const k = ev.key.toLowerCase()
      if (k === 'z') return ev.shiftKey ? this.redo() : this.undo()
      if (k === 'y') return this.redo()
      return false
    }
    if (ev.altKey) return false

    if (ev.key === 'Escape') {
      if (this.draft) this.cancelDraft()
      else this.deselect()
      return true
    }
    if (ev.key === 'Enter') {
      if (!this.draft) return false
      this.commitDraft()
      return true
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') return this.deleteSelected()

    const t = TOOL_KEYS.indexOf(ev.key)
    if (t >= 0) {
      this.setTool(TOOLS[t])
      return true
    }

    if (!this.gizmo.attached) return false
    const k = ev.key.toLowerCase()
    if (k === 'g') return this.gizmo.setMode('translate')
    if (k === 'r') return this.gizmo.setMode('rotate')
    if (k === 's') return this.gizmo.setMode('scale')
    if (k === 'x' || k === 'y' || k === 'z') {
      // Blender-style: press an axis to constrain, press the same axis again to
      // let go of the constraint. A toggle rather than an armed-after-G-R-S
      // latch, because the latch has an invisible state and this does not.
      const axis = k.toUpperCase()
      this.gizmo.setAxisFilter(this.gizmo.axes === axis ? 'XYZ' : axis)
      return true
    }
    return false
  }

  // --- clicks ---------------------------------------------------------------

  _click(ev, isDouble) {
    if (this.draft) {
      if (isDouble) {
        this.commitDraft()
        return
      }
      const hit = this._pickEvent(ev)
      if (!hit) return
      const on = this._clampXZ(hit.x, hit.z)
      this.draft.pts.push([on.x, hit.y, on.z, this.draft.width])
      return
    }

    // A handle wins over the ground under it, in every tool. Otherwise the only
    // way to grab an existing point while a placement tool is armed is to switch
    // tools first, and reaching for one drops a new object on top of it.
    const handle = this._hitHandle(ev)
    if (handle) {
      this.select(handle.kind, handle.id, handle.index)
      return
    }

    const hit = this._pickEvent(ev)
    if (!hit) {
      if (this.tool === 'select') this.deselect()
      return
    }

    if (this.tool === 'select') {
      this.deselect()
      return
    }
    // The height field answers everywhere, including past the world box, so a
    // shallow ray fired at the horizon lands OUTSIDE it. Placement clamps for
    // the same reason edits do.
    const at = this._clampXZ(hit.x, hit.z)

    if (this.tool === 'snowline') {
      const i = this.layers.addSnowPoint(at.x, at.z, SNOW_DELTA, SNOW_RADIUS)
      this._commit()
      this.select('snow', null, i)
      return
    }
    if (this.tool === 'lake') {
      // Layers.addLake allocates the id and hands back the RECORD, not the id.
      const lake = this.layers.addLake({ x: at.x, z: at.z, y: hit.y + LAKE_LIFT, ...LAKE_DEFAULTS })
      this._commit()
      this.select('lake', lake.id, null)
      return
    }
    // river / road
    this.deselect()
    this.draft = { kind: this.tool, width: PATH_WIDTH[this.tool], pts: [[at.x, hit.y, at.z, PATH_WIDTH[this.tool]]], cursor: hit }
    this.preview.visible = true
    this._repaintPreview()
  }

  _hitHandle(ev) {
    const ndc = pointerNdc(ev, this.renderer.domElement)
    this._pointer.set(ndc.x, ndc.y)
    this._raycaster.setFromCamera(this._pointer, this.camera)
    const hit = this.markers.hitTest(this._raycaster)
    if (!hit) return null
    return this._editorHandle(hit)
  }

  // The other direction of markerHandle: a Markers hit, in the editor's terms.
  // A spline bead does not know whether it belongs to a river or a road -- both
  // live in the same InstancedMesh -- so the kind comes from the path record.
  _editorHandle(hit) {
    if (hit.kind === 'snow') return { kind: 'snow', id: null, index: hit.index }
    if (hit.kind === 'lake') return { kind: 'lake', id: hit.id, index: null }
    if (hit.kind === 'spline') return { kind: this._path(hit.id).kind, id: hit.id, index: hit.index }
    throw new Error(`Editor: markers.hitTest returned kind ${hit.kind}, expected snow/spline/lake`)
  }

  _pickEvent(ev) {
    const ndc = pointerNdc(ev, this.renderer.domElement)
    const { origin, dir } = screenRay(this.camera, ndc.x, ndc.y)
    return raymarchGround(this.height, origin, dir)
  }

  _pickNdc() {
    const { origin, dir } = screenRay(this.camera, this._ndc.x, this._ndc.y)
    return raymarchGround(this.height, origin, dir)
  }

  // --- splines in progress --------------------------------------------------

  commitDraft() {
    const d = this.draft
    if (!d) return
    if (d.pts.length < 2) {
      // One point is not a path. Silently keeping it would put an object in the
      // document that no bake can do anything with.
      this.cancelDraft()
      this.error = 'a river or road needs at least two points'
      return
    }
    this.draft = null
    this.preview.visible = false
    // One record, not (kind, pts): depth and feather come from paths.js's own
    // defaults, so the editor does not get a second opinion about how deep a
    // river is. Returns the RECORD, with the allocated id on it.
    const path = this.layers.addPath({ kind: d.kind, pts: d.pts })
    this._commit()
    this.setTool('select')
    this.select(d.kind, path.id, null)
  }

  cancelDraft() {
    // The WHOLE in-progress path, per §18 -- Escape is "I did not mean to start
    // this", not "take back the last point".
    this.draft = null
    this.preview.visible = false
    this.preview.geometry.setDrawRange(0, 0)
  }

  _repaintPreview() {
    const d = this.draft
    const pts = d.pts.map((p) => new THREE.Vector3(p[0], p[1] + PREVIEW_LIFT, p[2]))
    if (d.cursor) pts.push(new THREE.Vector3(d.cursor.x, d.cursor.y + PREVIEW_LIFT, d.cursor.z))
    if (pts.length < 2) {
      this.preview.geometry.setDrawRange(0, 0)
      return
    }

    // CENTRIPETAL, matching §18's stored representation exactly. A uniform
    // Catmull-Rom preview would show a curve the bake will not produce -- and
    // the overshoot uniform gives on a tight turn is precisely the case where
    // the difference matters and the author needs to see it.
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
    const n = Math.min(PREVIEW_MAX_VERTS, pts.length * 16) - 1
    const samples = curve.getPoints(n)
    const arr = this.preview.geometry.attributes.position.array
    for (let i = 0; i < samples.length; i++) {
      arr[i * 3] = samples[i].x
      arr[i * 3 + 1] = samples[i].y
      arr[i * 3 + 2] = samples[i].z
    }
    this.preview.geometry.attributes.position.needsUpdate = true
    this.preview.geometry.setDrawRange(0, samples.length)
  }

  // --- gizmo <-> document ---------------------------------------------------

  /**
   * Put the proxy where the selection is and refresh `_dragBase`. Returns the
   * gizmo config the selection wants, or null for a selection nothing can drag.
   * Split out from `_attachGizmo` because a numeric edit in the panel has to
   * move the proxy WITHOUT re-attaching -- re-attaching resets the gizmo's mode,
   * so scrubbing `rx` would kick you out of scale mode on every tick.
   */
  _syncProxy() {
    const sel = this.selection
    if (!sel) return null

    if (sel.kind === 'lake') {
      const lake = this._lake(sel.id)
      const g = gizmoFromLake(lake)
      this.proxy.position.set(g.position.x, g.position.y, g.position.z)
      this.proxy.rotation.set(0, g.rotationY, 0)
      this.proxy.scale.set(1, 1, 1)
      this.proxy.updateMatrixWorld()
      this._dragBase = { ...lake }
      // All three modes: translate moves it and Y is the water level, scale is
      // rx/rz, rotate is `rot`. Rotate is pinned to Y because a lake stores one
      // angle and a free tumble has nowhere to go.
      return { modes: ['translate', 'rotate', 'scale'], axes: { rotate: 'Y' } }
    }

    if (sel.index === null) {
      // A whole path selected. Dragging every control point at once is not a
      // gizmo operation this editor offers, so the panel's fields and Delete are
      // the whole interaction -- clicking one of its points is how you move it.
      this._dragBase = null
      return null
    }

    const p = this._selectionPoint(sel)
    this.proxy.position.set(p.x, p.y, p.z)
    this.proxy.rotation.set(0, 0, 0)
    this.proxy.scale.set(1, 1, 1)
    this.proxy.updateMatrixWorld()
    this._dragBase = null
    // A point has no rotation and no size, so it gets translate and nothing
    // else. Offering R and S here would offer controls with nowhere to write.
    return { modes: ['translate'] }
  }

  _attachGizmo() {
    const cfg = this._syncProxy()
    if (!cfg) {
      this.gizmo.detach()
      return
    }
    this.gizmo.attachTo(this.proxy, cfg)
  }

  _selectionPoint(sel) {
    if (sel.kind === 'snow') {
      const p = this._snowPoint(sel.index)
      // A snow point stores no elevation -- it is a deviation of a CONTOUR, not
      // a thing in space -- so the handle rides on the ground beneath it.
      return { x: p.x, y: this.height.heightAt(p.x, p.z, 0), z: p.z }
    }
    const p = this._pathPoint(sel.id, sel.index)
    return { x: p[0], y: p[1], z: p[2] }
  }

  /**
   * Re-resolve the selected point handle by WORLD POSITION, for use around any
   * edit that can renumber the list it lives in. Returns a function to call
   * after the edit. See handles.js for why this does not lean on either layer's
   * current removal convention.
   */
  _holdPointHandle() {
    const sel = this.selection
    if (!sel || sel.index === null) return () => {}
    const want = sel.kind === 'snow'
      ? { x: this._snowPoint(sel.index).x, z: this._snowPoint(sel.index).z }
      : pathPointPos(this._pathPoint(sel.id, sel.index))
    return () => {
      const found = sel.kind === 'snow'
        ? rebindIndex(this.layers.snow.points, want, snowPointPos)
        : rebindIndex(this._path(sel.id).pts, want, pathPointPos)
      // Gone means the selected point was the one removed. A path falls back to
      // the whole path, which is still there; a snow point has no whole to fall
      // back to, so the selection ends.
      if (found === null && sel.kind === 'snow') this.deselect()
      else this.select(sel.kind, sel.id, found)
    }
  }

  _onGizmoChange() {
    const sel = this.selection
    if (!sel) return
    const p = this.proxy.position
    // A translate handle can be dragged past the horizon; the record may not
    // follow it out of the box. See _clampXZ.
    const at = this._clampXZ(p.x, p.z)

    if (sel.kind === 'snow') {
      this.layers.moveSnowPoint(sel.index, at.x, at.z)
    } else if (sel.kind === 'lake') {
      this._euler.setFromQuaternion(this.proxy.quaternion, 'YXZ')
      const patch = lakeFromGizmo(this._dragBase, {
        position: { x: p.x, y: p.y, z: p.z },
        rotationY: this._euler.y,
        scale: { x: this.proxy.scale.x, y: this.proxy.scale.y, z: this.proxy.scale.z },
      })
      patch.x = at.x
      patch.z = at.z
      this.layers.updateLake(sel.id, patch)
    } else {
      this.layers.movePathPoint(sel.id, sel.index, at.x, p.y, at.z)
    }
    this._touch()
  }

  _onGizmoCommit() {
    // Fold the drag into the record and put the proxy back at scale 1, so the
    // NEXT drag is relative to the size the lake now has. This is the other half
    // of lake-transform.js's relative-scale rule; skipping it makes every drag
    // after the first compound against a stale base.
    this._syncProxy()
    this._commit()
  }

  // --- dirty rects, commits, undo -------------------------------------------

  _touch() {
    this._pending = true
  }

  _flushDirty(force) {
    if (!force) {
      if (!this._pending) return
      if (performance.now() - this._lastDirty < DIRTY_MS) return
    }
    this._pending = false
    this._lastDirty = performance.now()
    const rect = this.layers.takeDirtyRect()
    if (rect) this.onDirty(rect)
  }

  /** One undo boundary: snapshot, remesh now, resync the handles, autosave. */
  _commit() {
    this.history.push(this.snapshot())
    this._flushDirty(true)
    this.markers.sync()
    this._autosave()
  }

  _autosave() {
    try {
      saveLocal(this.layers)
    } catch (e) {
      // A quota or private-mode failure must be visible: silently not autosaving
      // is indistinguishable from autosaving until the reload that loses a day.
      this.error = `autosave failed: ${e.message}`
    }
  }

  undo() {
    const snap = this.history.undo()
    if (snap === null) return false
    this._apply(snap)
    return true
  }

  redo() {
    const snap = this.history.redo()
    if (snap === null) return false
    this._apply(snap)
    return true
  }

  /** Replace the world with a document, without touching the history stack. */
  _apply(text) {
    this.cancelDraft()
    this.deselect()
    restoreLayers(this.layers, JSON.parse(text))
    this._flushDirty(true)
    this.markers.sync()
    this._autosave()
  }

  /** Load / Import: adopt a document and make it the new undo origin. */
  loadDoc(json) {
    this._apply(JSON.stringify(json))
    this.history.reset(this.snapshot())
  }

  // --- what the panel reads -------------------------------------------------

  /**
   * The selected object's fields. A row with a `set` is editable; one without is
   * a readout. `{label, value}` is the shape the panel promises; everything else
   * is optional detail it uses when present.
   *
   * `set(value, commit)` takes a SECOND argument, and it matters: the panel's
   * drag-to-scrub calls it many times per second with `commit = false`, which
   * writes the document and lets the ordinary 120 ms debounce carry the remesh,
   * but does NOT push undo. A commit per scrub tick would put fifty entries on a
   * 64-deep stack for one drag. The release calls it once with `commit = true`,
   * which is the same undo boundary a gizmo drag uses.
   */
  status() {
    const sel = this.selection
    if (!sel) return []

    // Every range below is DERIVED, never typed: horizontal ones from the world
    // box in config.js, vertical ones from the elevation range the host read out
    // of the loaded heightmap. Both moved once already (16 km -> 4 km, and a
    // procedural field -> an imported image), and a hardcoded bound survives that
    // by clamping the user out of half the world without saying anything.
    const xz = { min: -WORLD_HALF, max: WORLD_HALF, unit: 'm' }
    const { min: yMin, max: yMax } = this.elevation
    const relief = this.relief

    if (sel.kind === 'snow') {
      // Throws rather than returning [] on a dead handle: an empty context panel
      // beside a drawn selection is a bug that shows as nothing at all, and the
      // selection cannot legitimately outlive its point (removeAt re-resolves).
      const p = this._snowPoint(sel.index)
      return [
        { label: 'snow point', value: `#${sel.index}` },
        { label: 'x', value: p.x, step: 1, ...xz, set: (v, c) => this._setSnow(sel.index, { x: v }, c) },
        { label: 'z', value: p.z, step: 1, ...xz, set: (v, c) => this._setSnow(sel.index, { z: v }, c) },
        // A local snow line may be pushed anywhere within the world's relief and
        // no further: past that it is above the summit or below the shore, which
        // are both just "always" and "never" with extra numbers.
        { label: 'delta', value: p.delta, step: 1, min: -relief, max: relief, unit: 'm', set: (v, c) => this._setSnow(sel.index, { delta: v }, c) },
        // SnowField.setPoint refuses a radius <= 0, so the minimum is a real
        // bound rather than a nicety. 10 m is also under one grid TEXEL, which
        // is where the baked line stops resolving what the author asked for.
        { label: 'radius', value: p.radius, step: 10, min: 10, max: WORLD_SIZE, unit: 'm', set: (v, c) => this._setSnow(sel.index, { radius: v }, c) },
        { label: 'line here', value: this.layers.snowLineAt(p.x, p.z), unit: 'm' },
        { label: 'ground here', value: this.height.heightAt(p.x, p.z, 0), unit: 'm' },
      ]
    }

    if (sel.kind === 'lake') {
      const l = this._lake(sel.id)
      const patch = (k) => (v, commit = true) => this._setLake(sel.id, { [k]: v }, commit)
      return [
        { label: 'lake', value: l.id },
        { label: 'x', value: l.x, step: 1, ...xz, set: patch('x') },
        { label: 'y', value: l.y, step: 0.5, min: yMin, max: yMax, unit: 'm water', set: patch('y') },
        { label: 'z', value: l.z, step: 1, ...xz, set: patch('z') },
        { label: 'rx', value: l.rx, step: 1, min: MIN_LAKE_RADIUS, max: WORLD_HALF, unit: 'm', set: patch('rx') },
        { label: 'rz', value: l.rz, step: 1, min: MIN_LAKE_RADIUS, max: WORLD_HALF, unit: 'm', set: patch('rz') },
        {
          label: 'rot',
          value: (l.rot * 180) / Math.PI,
          step: 1,
          unit: 'deg',
          set: (v, commit = true) => this._setLake(sel.id, { rot: (v * Math.PI) / 180 }, commit),
        },
        { label: 'depth', value: l.depth, step: 0.5, min: 0, max: relief, unit: 'm', set: patch('depth') },
        { label: 'carve', value: l.carve, step: 1, min: 0, max: 1, set: patch('carve') },
        { label: 'shape', value: l.shape, step: 1, min: 0, max: 1, set: patch('shape') },
      ]
    }

    const path = this._path(sel.id)
    const live = this._pathCount(sel.id)
    if (sel.index === null) {
      return [
        { label: sel.kind, value: path.id },
        { label: 'points', value: live },
        { label: 'depth', value: path.depth, unit: 'm' },
        { label: 'feather', value: path.feather, unit: 'm' },
      ]
    }
    const p = this._pathPoint(sel.id, sel.index)
    return [
      // The handle is an index into pts INCLUDING tombstones and the count is
      // of the live ones, so "#5 of 4" is a correct reading of a path that has
      // had a point deleted, not a bug in this row.
      { label: sel.kind, value: `${path.id} #${sel.index} of ${live}` },
      { label: 'x', value: p[0], step: 1, ...xz, set: (v, c) => this._setPathPoint(sel, { x: v }, c) },
      { label: 'y', value: p[1], step: 0.5, min: yMin, max: yMax, unit: 'm', set: (v, c) => this._setPathPoint(sel, { y: v }, c) },
      { label: 'z', value: p[2], step: 1, ...xz, set: (v, c) => this._setPathPoint(sel, { z: v }, c) },
      { label: 'width', value: p[3], step: 0.5, min: 0.5, max: PATH_WIDTH_MAX, unit: 'm', set: (v, c) => this._setPathPoint(sel, { width: v }, c) },
      { label: 'ground here', value: this.height.heightAt(p[0], p[2], 0), unit: 'm' },
    ]
  }

  /** One row per authored object, for the panel's layer list. */
  layerList() {
    const out = []
    const pts = this.layers.snow.points
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      // Holes, from SnowField.removePoint. They are not rows; the index they
      // hold open belongs to a point that no longer exists.
      if (p === null) continue
      // id null and label 's3': a snow point has no id in the document -- it is
      // addressed by its index alone -- and `id` here is what the panel hands
      // straight back to select() and removeAt(). They were once the same field
      // and the row for the selected snow point never highlighted, because
      // `sel.id` was null and the row's was the string.
      out.push({
        kind: 'snow',
        id: null,
        index: i,
        label: `s${i}`,
        summary: `${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(0)} m over r${p.radius.toFixed(0)}`,
      })
    }
    for (const l of this.layers.lakes.lakes.values()) {
      out.push({ kind: 'lake', id: l.id, index: null, label: l.id, summary: `${l.rx.toFixed(0)} x ${l.rz.toFixed(0)} m, y ${l.y.toFixed(0)}` })
    }
    for (const p of this.layers.paths.paths.values()) {
      out.push({ kind: p.kind, id: p.id, index: null, label: p.id, summary: `${this._pathCount(p.id)} pts` })
    }
    return out
  }

  // --- private helpers ------------------------------------------------------

  // LakeSet.update REPLACES the record in the map rather than mutating it, so
  // every read goes through the map and no caller may hold a lake across an
  // edit. Same shape for paths, for symmetry rather than necessity.
  _lake(id) {
    const l = this.layers.lakes.lakes.get(id)
    if (l === undefined) throw new Error(`Editor: no lake ${id}`)
    return l
  }

  _path(id) {
    const p = this.layers.paths.paths.get(id)
    if (p === undefined) throw new Error(`Editor: no path ${id}`)
    return p
  }

  // A path point by HANDLE, which is an index into rec.pts and not a position
  // in the curve: PathSet.removePoint tombstones, so index 3 stays index 3 for
  // the rest of the session however many points below it are deleted.
  //
  // Through pointAt rather than pts[index], because pointAt distinguishes an
  // out-of-range index (arithmetic) from a tombstone (a handle held across a
  // delete) and says which. Indexing pts gives undefined or null and turns a
  // stale selection into a silent no-op drag.
  _pathPoint(id, index) {
    return this.layers.paths.pointAt(id, index)
  }

  /** Live control points of a path, tombstones excluded -- pts.length counts holes. */
  _pathCount(id) {
    return this.layers.paths.handlesOf(id).length
  }

  _snowPoint(index) {
    const p = this.layers.snow.points[index]
    // null is a HOLE, not an absence of data: SnowField.removePoint blanks the
    // slot to keep the indices above it stable. Either way there is nothing at
    // this handle and reading through it would be reading a deleted point.
    if (p === undefined || p === null) throw new Error(`Editor: no snow point at index ${index}`)
    return p
  }

  /** Metres from the world's lowest ground to its highest, per the loaded bake. */
  get relief() {
    return this.elevation.max - this.elevation.min
  }

  // Nothing may be authored outside the world box. The quadtree has no node to
  // put it in, so a lake at x = 5000 in a 4096 m world is a record that renders
  // nowhere, cannot be clicked, and cannot be selected back to be deleted --
  // it is only visible as a line in layers.json. Clamping at the edit is the
  // one place that can still SHOW where it went, by refusing to move it further.
  _clampXZ(x, z) {
    return {
      x: Math.min(WORLD_HALF, Math.max(-WORLD_HALF, x)),
      z: Math.min(WORLD_HALF, Math.max(-WORLD_HALF, z)),
    }
  }

  // `commit` false is the scrub path: write the document, let the 120 ms
  // debounce carry the remesh, and leave the undo stack alone. See status().
  _after(commit) {
    if (commit) this._commit()
    else this._touch()
    if (!this.gizmo.dragging) this._syncProxy()
  }

  _setSnow(index, patch, commit = true) {
    const p = this._snowPoint(index)
    if ('x' in patch || 'z' in patch) {
      const at = this._clampXZ('x' in patch ? patch.x : p.x, 'z' in patch ? patch.z : p.z)
      this.layers.moveSnowPoint(index, at.x, at.z)
    }
    if ('delta' in patch || 'radius' in patch) this.layers.setSnowPoint(index, patch)
    this._after(commit)
  }

  _setLake(id, patch, commit = true) {
    if ('x' in patch || 'z' in patch) {
      const l = this._lake(id)
      const at = this._clampXZ('x' in patch ? patch.x : l.x, 'z' in patch ? patch.z : l.z)
      patch = { ...patch, x: at.x, z: at.z }
    }
    this.layers.updateLake(id, patch)
    this._after(commit)
  }

  _setPathPoint(sel, patch, commit = true) {
    const p = this._pathPoint(sel.id, sel.index)
    if ('width' in patch) this.layers.setPathWidth(sel.id, sel.index, patch.width)
    if ('x' in patch || 'y' in patch || 'z' in patch) {
      const at = this._clampXZ('x' in patch ? patch.x : p[0], 'z' in patch ? patch.z : p[2])
      this.layers.movePathPoint(sel.id, sel.index, at.x, 'y' in patch ? patch.y : p[1], at.z)
    }
    this._after(commit)
  }

  dispose() {
    this.gizmo.dispose()
    this.scene.remove(this.proxy)
    this.scene.remove(this.preview)
    this.preview.geometry.dispose()
    this.preview.material.dispose()
  }
}
