import * as THREE from 'three'

// ---------------------------------------------------------------------------
// In-world debug HUD.
//
// You cannot see a JS console while wearing the headset, and chrome://inspect
// is slow enough that you will avoid using it. Every number we care about has
// to be readable in VR. Per DESIGN.md §0 this panel stays in the project
// permanently, toggled by a controller button.
// ---------------------------------------------------------------------------

const W = 1024
const H = 640

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
    this.domMirror = document.getElementById('desktop-hud')

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
    this.mesh.visible = this.visible
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
      if (line.startsWith('##')) {
        c.fillStyle = '#7fd1ff'
        c.fillText(line.slice(2).trim(), 22, y)
      } else if (line.startsWith('!!')) {
        c.fillStyle = '#ff9a7a'
        c.fillText(line.slice(2).trim(), 22, y)
      } else if (line.startsWith('++')) {
        c.fillStyle = '#9dffb0'
        c.fillText(line.slice(2).trim(), 22, y)
      } else {
        c.fillStyle = '#cfe3ff'
        c.fillText(line, 22, y)
      }
      y += 30
    }

    this.texture.needsUpdate = true

    if (this.domMirror) {
      this.domMirror.textContent = this.lines
        .map((l) => l.replace(/^(##|!!|\+\+)\s*/, ''))
        .join('\n')
    }
  }
}
