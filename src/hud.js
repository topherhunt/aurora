import THREE from './three-instance.js'

// ---------------------------------------------------------------------------
// In-world debug HUD.
//
// You cannot see a JS console while wearing the headset, and chrome://inspect
// is slow enough that you will avoid using it. Every number we care about has
// to be readable in VR. Per DESIGN.md §0 this panel stays in the project
// permanently, toggled by a controller button.
//
// There are two surfaces for one panel and exactly one of them is ever live:
// the head-locked canvas mesh in XR, the DOM mirror on desktop. They are not
// alternatives in the sense of "pick your favourite" -- the canvas one is the
// only one that exists inside the headset, and on a monitor it is a blurry
// floating rectangle over the middle of the screen repeating what the crisp
// corner panel already says. `setPresenting()` is what arbitrates, and both
// surfaces render the same `lines` array with the same colour coding.
// ---------------------------------------------------------------------------

const W = 1024
const H = 640

// Line colours, keyed by a two-character prefix the caller puts on the line.
// A prefix is a semantic tag, not a colour name: `##` is a section heading,
// `!!` is something wrong, `++` is something good, `%%` is a measurement.
const PREFIX_COLORS = {
  '##': '#7fd1ff',
  '!!': '#ff9a7a',
  '++': '#9dffb0',
  '%%': '#ff5f52',
}
const BODY_COLOR = '#cfe3ff'

function classify(line) {
  const color = PREFIX_COLORS[line.slice(0, 2)]
  return color ? { color, text: line.slice(2).trim() } : { color: BODY_COLOR, text: line }
}

// The lines are ours, not user input, but they interpolate free-form strings
// (prop kind names, error text) and this is set with innerHTML. Escaping is one
// line and removes the whole category.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class Hud {
  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false

    const geo = new THREE.PlaneGeometry(0.62, 0.62 * (H / W))
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.renderOrder = 999
    this.mesh.frustumCulled = false

    this.lines = []
    this.visible = true
    this.presenting = false
    this.domMirror = document.getElementById('desktop-hud')
    this._applyVisibility()

    this._pos = new THREE.Vector3()
    this._quat = new THREE.Quaternion()
    this._fwd = new THREE.Vector3()
    this._target = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._lastPaint = 0
  }

  setLines(lines) {
    this.lines = lines
  }

  toggle() {
    this.visible = !this.visible
    this._applyVisibility()
  }

  // Call on XR sessionstart/sessionend. Which surface is live is a property of
  // where she is looking, not a preference, so it is not on the H toggle.
  setPresenting(presenting) {
    this.presenting = presenting
    this._applyVisibility()
  }

  _applyVisibility() {
    this.mesh.visible = this.visible && this.presenting
    if (this.domMirror) this.domMirror.style.display = this.visible && !this.presenting ? '' : 'none'
  }

  // Head-locked with damping so it does not jitter with micro head motion.
  follow(camera, dt) {
    camera.getWorldPosition(this._pos)
    camera.getWorldQuaternion(this._quat)
    this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
    this._target
      .copy(this._pos)
      .addScaledVector(this._fwd, 1.1)
      .addScaledVector(this._up, -0.28)

    const k = 1 - Math.exp(-10 * dt)
    this.mesh.position.lerp(this._target, k)
    this.mesh.quaternion.slerp(this._quat, k)
  }

  // Canvas -> GPU upload is not free. Repaint at 4Hz, not per frame.
  paint(now) {
    if (now - this._lastPaint < 250) return
    this._lastPaint = now
    if (!this.visible) return

    if (this.presenting) this._paintCanvas()
    else this._paintDom()
  }

  _paintDom() {
    if (!this.domMirror) return
    this.domMirror.innerHTML = this.lines
      .map((line) => {
        const { color, text } = classify(line)
        return `<span style="color:${color}">${escapeHtml(text)}</span>`
      })
      .join('\n')
  }

  _paintCanvas() {
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    c.fillStyle = 'rgba(8,14,26,0.86)'
    c.fillRect(0, 0, W, H)
    c.strokeStyle = '#2b4a72'
    c.lineWidth = 4
    c.strokeRect(2, 2, W - 4, H - 4)

    c.font = '600 26px ui-monospace, Menlo, monospace'
    c.textBaseline = 'top'
    let y = 22
    for (const line of this.lines) {
      const { color, text } = classify(line)
      c.fillStyle = color
      c.fillText(text, 22, y)
      y += 30
    }

    this.texture.needsUpdate = true
  }
}
