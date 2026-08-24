import { TransformControls } from 'three/addons/controls/TransformControls.js'

// ---------------------------------------------------------------------------
// The move / rotate / scale widget.
//
// It is three's own `TransformControls`, wrapped -- and per §18 "Editing" that
// is a deliberate choice rather than a shortcut: it is the Blender-style gizmo
// already written, tested and shipped inside the dependency this project already
// has, and reimplementing it means several hundred lines of ray-plane
// intersection, screen-space handle sizing, hover picking and axis snapping to
// arrive at something worse. What is NOT already written is everything in this
// file: which modes a given selection is allowed to use, the axis-constraint
// keys, and the change/commit split the host debounces against.
//
// THREE 0.180 API NOTE, checked against
// node_modules/three/examples/jsm/controls/TransformControls.js rather than
// guessed: `TransformControls extends Controls`, NOT Object3D (that changed in
// r169). `scene.add(controls)` would throw. The scene node is `getHelper()`,
// which returns the internal TransformControlsRoot. The class self-connects its
// pointer listeners to `domElement` in the constructor, so it sees pointer
// events whether or not the host forwards them -- which is why `overHandle`
// exists below for the host to check before treating a click as a world click.
//
// orbitLock() is not optional and not a nicety. TransformControls and mouse-look
// both start on pointerdown over the canvas; without suspending the camera, a
// drag on the Y arrow also spins the view, and the object appears to fly off in
// a direction nobody asked for. It is wired to `dragging-changed` so it cannot
// get out of step with the drag it is guarding.
// ---------------------------------------------------------------------------

export const MODES = ['translate', 'rotate', 'scale']

export class Gizmo {
  constructor({ scene, camera, domElement, orbitLock }) {
    if (typeof orbitLock !== 'function') throw new Error('Gizmo: orbitLock(bool) is required -- see the header')
    this.scene = scene
    this.orbitLock = orbitLock

    this.controls = new TransformControls(camera, domElement)
    // Local space, always. A lake's rx/rz are half-extents along its OWN axes,
    // so a world-space scale drag on a rotated lake would map onto the wrong
    // pair of numbers. (TransformControls forces local for scale internally
    // anyway; setting it here makes translate agree instead of surprising.)
    this.controls.setSpace('local')

    this.helper = this.controls.getHelper()
    this.helper.visible = false
    scene.add(this.helper)

    this.modes = MODES.slice()
    this.axisFilter = 'XYZ'
    this._axesByMode = {}
    this._changeCbs = []
    this._commitCbs = []

    this.controls.addEventListener('dragging-changed', (e) => this.orbitLock(e.value === true))
    this.controls.addEventListener('objectChange', () => {
      for (const cb of this._changeCbs) cb(this.controls.object)
    })
    this.controls.addEventListener('mouseUp', () => {
      for (const cb of this._commitCbs) cb(this.controls.object)
    })
  }

  /** Fires continuously through a drag, with the object being dragged. */
  onChange(cb) {
    this._changeCbs.push(cb)
  }

  /** Fires once on mouse-up. This is the host's undo boundary. */
  onCommit(cb) {
    this._commitCbs.push(cb)
  }

  /**
   * `modes` is the subset of translate/rotate/scale that MEANS anything for the
   * thing selected -- a snow-line point or a spline point is a position and
   * nothing else, so offering it a rotate handle is offering a control that
   * cannot write anywhere. `axes` is an optional per-mode default constraint,
   * e.g. `{ rotate: 'Y' }` for a lake, whose `rot` is a single angle about Y and
   * which would otherwise accept a tumble it has no field to store.
   */
  attachTo(object3D, { modes = MODES, axes = {} } = {}) {
    if (!modes.length) throw new Error('Gizmo.attachTo: needs at least one mode')
    for (const m of modes) if (!MODES.includes(m)) throw new Error(`Gizmo.attachTo: unknown mode ${m}`)
    this.modes = modes.slice()
    this._axesByMode = axes
    this.controls.attach(object3D)
    this.helper.visible = true
    this.setMode(this.modes.includes(this.controls.mode) ? this.controls.mode : this.modes[0])
  }

  detach() {
    if (this.controls.dragging) this.orbitLock(false)
    this.controls.detach()
    this.helper.visible = false
  }

  get attached() {
    return this.controls.object !== undefined
  }

  get dragging() {
    return this.controls.dragging === true
  }

  /**
   * True when the cursor is over a handle. The host checks this on pointerdown:
   * TransformControls has its own listener on the same element, so without it a
   * click that grabs an arrow would ALSO be handled as a click on the world
   * behind the arrow -- which, in a placement tool, drops a lake every time you
   * reach for the gizmo.
   */
  get overHandle() {
    return this.attached && this.controls.axis !== null
  }

  get mode() {
    return this.controls.mode
  }

  /** Returns false when the current selection has no such mode (G on a point). */
  setMode(mode) {
    if (!this.modes.includes(mode)) return false
    this.controls.setMode(mode)
    this.setAxisFilter(this._axesByMode[mode] ?? 'XYZ')
    return true
  }

  /** `axes` is any subset of the letters XYZ; 'XYZ' restores the unconstrained gizmo. */
  setAxisFilter(axes) {
    const s = String(axes).toUpperCase()
    if (!/^[XYZ]{1,3}$/.test(s)) throw new Error(`Gizmo.setAxisFilter: ${axes} is not a subset of XYZ`)
    this.controls.showX = s.includes('X')
    this.controls.showY = s.includes('Y')
    this.controls.showZ = s.includes('Z')
    this.axisFilter = s
  }

  get axes() {
    return this.axisFilter
  }

  dispose() {
    this.detach()
    this.scene.remove(this.helper)
    this.controls.disconnect()
    this.controls.dispose()
  }
}
