import * as THREE from 'three'
import { warningCount } from '../log-ship.js'

// A red "!" in the top-left for SHOW_S after any reportWarning: a soft exception
// happened and the logs are worth pulling. On the camera, so it holds in the
// headset, drawn over the vitals HUD (render/vitals-hud.js, renderOrder 1e6+4).
const ORDER = 1e6 + 10
const SHOW_S = 1

export class WarnMark {
  constructor(camera) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const g = canvas.getContext('2d')
    g.font = 'bold 112px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 10
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)'
    g.strokeText('!', 64, 68)
    g.fillStyle = '#e01b1b'
    g.fillText('!', 64, 68)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }),
    )
    this.mesh.renderOrder = ORDER
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    camera.add(this.mesh)
    this.seen = 0
    this.t = 0
  }

  /** The top-left of the desktop's frustum, or a fixed glance up and left in the headset (mirroring the vitals donut). */
  place(xr, fovDeg, aspect) {
    const d = 0.8
    if (xr) {
      this.mesh.scale.setScalar(0.06)
      this.mesh.position.set(-0.24, 0.22, -d)
      return
    }
    const halfH = d * Math.tan((fovDeg * Math.PI) / 360), halfW = halfH * aspect
    const size = 0.12 * halfH
    this.mesh.scale.setScalar(size)
    this.mesh.position.set(-halfW + size, halfH - size, -d)
  }

  update(dt) {
    const n = warningCount()
    if (n !== this.seen) {
      this.seen = n
      this.t = SHOW_S
    }
    this.t = Math.max(0, this.t - dt)
    this.mesh.visible = this.t > 0
  }
}
