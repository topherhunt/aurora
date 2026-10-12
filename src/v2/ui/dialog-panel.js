// The conversation panel (_notes/conversation-and-quests.md, "The dialog grid"): who she is talking to and their
// last line, over the 4x4 grid of fragments (talk/grid.js). It stands between her and the speaker, below their face,
// turned to her. Two meshes, two canvases, drawn over the world like the quest menu.
import THREE from '../../three-instance.js'
import { GRID } from '../talk/grid.js'

export const DIALOG = {
  // Metres, at her scale: the grid's cells and gaps, the caption above.
  cellW: 0.3, cellH: 0.12, gap: 0.015, captionH: 0.26,
  // How far in front of her it stands (never past the speaker), and how far under her eye.
  ahead: 1.3, below: 0.35,
  pxPerM: 600,
  order: 1005,
}

const SERIF = (px, weight = 'bold') => `${weight} ${px}px "Noto Serif", Georgia, "Times New Roman", serif`
const FILL = { back: '#3c2a17', stem: '#173154', send: '#245c33', more: '#2c2c44', empty: 'rgba(0,0,0,0)' }

function canvasTexture(w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  return { ctx: canvas.getContext('2d'), texture }
}

const material = (texture) => new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, toneMapped: false, forceSinglePass: true, depthTest: false, depthWrite: false })

/** Words `text` broken into lines no wider than `w` px in the context's font. */
function wrap(ctx, text, w) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > w) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export class DialogPanel {
  /** `upload(texture)` puts a redrawn canvas on the GPU between frames (main.js uploadQuestTexture). */
  constructor(scene, upload) {
    this.upload = upload
    this.group = new THREE.Group()
    this.group.visible = false
    scene.add(this.group)
    const D = DIALOG
    const width = GRID.cols * D.cellW + (GRID.cols - 1) * D.gap
    const gridH = GRID.rows * D.cellH + (GRID.rows - 1) * D.gap
    this.cellPx = [Math.round(D.cellW * D.pxPerM), Math.round(D.cellH * D.pxPerM)]
    this.grid = canvasTexture(this.cellPx[0] * GRID.cols, this.cellPx[1] * GRID.rows)
    // Loose quads over one atlas, row-major: cell i is row floor(i / cols), column i % cols.
    const n = GRID.cols * GRID.rows
    const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint16Array(n * 6)
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / GRID.cols), c = i % GRID.cols
      const x0 = -width / 2 + c * (D.cellW + D.gap), y1 = -r * (D.cellH + D.gap)
      pos.set([x0, y1 - D.cellH, 0, x0 + D.cellW, y1 - D.cellH, 0, x0 + D.cellW, y1, 0, x0, y1, 0], i * 12)
      const u0 = c / GRID.cols, u1 = (c + 1) / GRID.cols, v1 = 1 - r / GRID.rows, v0 = 1 - (r + 1) / GRID.rows
      uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8)
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 3, i * 4], i * 6)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.mesh = new THREE.Mesh(geo, material(this.grid.texture))
    this.mesh.renderOrder = D.order + 1
    this.mesh.name = 'qa-dialog-grid'
    this.group.add(this.mesh)
    this.caption = canvasTexture(Math.round(width * D.pxPerM), Math.round(D.captionH * D.pxPerM))
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(width, D.captionH), material(this.caption.texture))
    cap.position.y = D.gap + D.captionH / 2
    cap.renderOrder = D.order
    this.group.add(cap)
    this.gridH = gridH
  }

  get open() {
    return this.group.visible
  }

  /** Show `name`'s line `text` and the grid `cells` (grid.js). */
  show(name, text, cells) {
    this.say(name, text)
    this.setCells(cells)
    this.group.visible = true
  }

  hide() {
    this.group.visible = false
  }

  say(name, text) {
    const { ctx, texture } = this.caption
    const { width: w, height: h } = ctx.canvas
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(12, 18, 30, 0.85)'
    ctx.fillRect(0, 0, w, h)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#f2d48a'
    ctx.font = SERIF(30)
    ctx.fillText(name, 16, 10)
    ctx.fillStyle = '#ffffff'
    ctx.font = SERIF(26, 'normal')
    const lines = wrap(ctx, text, w - 32)
    lines.slice(0, 4).forEach((l, i) => ctx.fillText(i === 3 && lines.length > 4 ? `${l}...` : l, 16, 50 + i * 32))
    this.upload(texture)
  }

  setCells(cells) {
    const { ctx, texture } = this.grid
    const [cw, ch] = this.cellPx
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    cells.forEach((cell, i) => {
      const x = (i % GRID.cols) * cw, y = Math.floor(i / GRID.cols) * ch
      ctx.fillStyle = FILL[cell.kind]
      ctx.fillRect(x, y, cw, ch)
      if (!cell.text || cell.kind === 'empty') return
      ctx.fillStyle = '#ffffff'
      ctx.font = SERIF(cell.kind === 'back' ? 44 : 26)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const lines = wrap(ctx, cell.text, cw - 16).slice(0, 2)
      lines.forEach((l, k) => ctx.fillText(l, x + cw / 2, y + ch / 2 + (k - (lines.length - 1) / 2) * 30))
    })
    this.upload(texture)
  }

  /** The cell a raycast hit lands on, or -1. */
  indexAt(hit) {
    if (!hit || hit.object !== this.mesh || hit.faceIndex == null) return -1
    return Math.floor(hit.faceIndex / 2)
  }

  /** Stand it between `eye` (her eye, world) and `speaker` (their position), at `scale`, turned to her. */
  place(eye, speaker, scale) {
    const dx = speaker.x - eye.x, dz = speaker.z - eye.z
    const d = Math.hypot(dx, dz) || 1
    const ahead = Math.min(DIALOG.ahead * scale, d * 0.7)
    this.group.position.set(eye.x + (dx / d) * ahead, eye.y - DIALOG.below * scale, eye.z + (dz / d) * ahead)
    this.group.scale.setScalar(scale)
    this.group.lookAt(eye.x, this.group.position.y, eye.z)
  }
}
