// The rune panel at a ward's anchor gem (design/46-castle-wards.md): the three runes picked so far over the ten to pick from,
// and clear and close. One canvas on one plane, drawn over the world like the dialog panel; a press lands by the hit's uv.
import THREE from '../../three-instance.js'
import { RUNES } from '../castles/wards.js'

export const RUNE_PANEL = { cols: 6, cell: 0.16, slotsH: 0.2, pxPerM: 700, ahead: 0.75, below: 0.25, leave: 3, order: 1005 }
const CLEAR = 10, CLOSE = 11

export class RunePanel {
  /** `runes()` the rune atlas texture (a canvas strip); `upload(texture)` as for the dialog panel. */
  constructor(scene, runes, upload) {
    const P = RUNE_PANEL, w = P.cols * P.cell, h = P.slotsH + 2 * P.cell
    this.runes = runes
    this.upload = upload
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.round(w * P.pxPerM)
    this.canvas.height = Math.round(h * P.pxPerM)
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide, transparent: true, toneMapped: false, depthTest: false, depthWrite: false }))
    this.mesh.renderOrder = P.order
    this.mesh.name = 'qa-rune-panel'
    this.group = new THREE.Group()
    this.group.visible = false
    this.group.add(this.mesh)
    scene.add(this.group)
    this.ward = -1
    this.picks = []
    this.gem = new THREE.Vector3()
  }

  get open() { return this.group.visible }

  /** Opened on ward `ward`'s gem at world `gem`, nothing picked. */
  show(ward, gem) {
    this.ward = ward
    this.picks = []
    this.gem.copy(gem)
    this.group.visible = true
    this._draw()
  }

  hide() {
    this.group.visible = false
    this.ward = -1
    this.picks = []
  }

  /** A raycast `hit` pressed on the panel: null when it misses, else { ward, code } once a third rune is picked (the panel shuts),
   * or { ward, code: null } for any other press. */
  press(hit) {
    if (!this.open || !hit || hit.object !== this.mesh) return null
    const P = RUNE_PANEL, h = P.slotsH + 2 * P.cell, y = (1 - hit.uv.y) * h
    if (y < P.slotsH) return { ward: this.ward, code: null }
    const k = Math.floor((y - P.slotsH) / P.cell) * P.cols + Math.min(P.cols - 1, Math.floor(hit.uv.x * P.cols))
    const ward = this.ward
    if (k === CLOSE) { this.hide(); return { ward, code: null } }
    if (k === CLEAR) this.picks = []
    else if (!this.picks.includes(k)) this.picks.push(k)
    if (this.picks.length < 3) { this._draw(); return { ward, code: null } }
    const code = this.picks
    this.hide()
    return { ward, code }
  }

  /** Each frame: stood between her `eye` and the gem, turned to her; shut once she walks `leave` m off. */
  keep(eye, scale) {
    if (!this.open) return
    const dx = this.gem.x - eye.x, dz = this.gem.z - eye.z, d = Math.hypot(dx, dz) || 1
    if (d > RUNE_PANEL.leave * scale) { this.hide(); return }
    const ahead = Math.min(RUNE_PANEL.ahead * scale, d * 0.7)
    this.group.position.set(eye.x + (dx / d) * ahead, eye.y - RUNE_PANEL.below * scale, eye.z + (dz / d) * ahead)
    this.group.scale.setScalar(scale)
    this.group.lookAt(eye.x, this.group.position.y, eye.z)
  }

  _draw() {
    const img = this.runes().image
    const P = RUNE_PANEL, g = this.canvas.getContext('2d'), W = this.canvas.width, px = P.pxPerM, cell = P.cell * px, top = P.slotsH * px
    g.clearRect(0, 0, W, this.canvas.height)
    g.fillStyle = 'rgba(14, 20, 40, 0.88)'
    g.fillRect(0, 0, W, this.canvas.height)
    const icon = (r, x, y, s) => { g.drawImage(img, r * img.width / RUNES.length, 0, img.width / RUNES.length, img.height, x, y, s, s) }
    for (let s = 0; s < 3; s++) {
      const sz = top - 16, x = W / 2 + (s - 1) * top * 1.05 - sz / 2, y = 8
      g.strokeStyle = '#6fb4ff'; g.lineWidth = 3
      g.strokeRect(x, y, sz, sz)
      if (s < this.picks.length) icon(this.picks[s], x + 6, y + 6, sz - 12)
    }
    for (let k = 0; k < 12; k++) {
      const x = (k % P.cols) * cell, y = top + Math.floor(k / P.cols) * cell
      g.fillStyle = this.picks.includes(k) ? '#2a3f70' : '#1b2546'
      g.fillRect(x + 4, y + 4, cell - 8, cell - 8)
      if (k < CLEAR) icon(k, x + 14, y + 14, cell - 28)
      else {
        g.fillStyle = '#ffffff'; g.font = `bold ${Math.round(cell * 0.22)}px Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
        g.fillText(k === CLEAR ? 'Clear' : 'Close', x + cell / 2, y + cell / 2)
      }
    }
    this.upload(this.texture)
  }
}
