// The signposts at the road forks (DESIGN.md §35): a hewn post propped in a cairn, with an arrow board for each town it names. Post and cairn are prop material; the boards read their names off one canvas atlas, dark brown on wood, legible from both sides. A post is built when the player comes within `near` and dropped past `far`, so only the few nearby cost anything.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { LAYER } from '../../textures.js'
import { mulberry32 } from '../../sim/mathx.js'

export const SIGN = { near: 250, far: 300, post: { h: 2.6, w: 0.14 }, board: { len: 1.3, h: 0.24, t: 0.045, tip: 0.2, gap: 0.3, top: 2.35 }, cairn: { stones: 11, r: 0.42 } }
const CELL = { w: 320, h: 60, cols: 4 }
const WOOD = '#9c7446'
const INK = '#3b2412'

// Every town's name, one cell each, on planked wood.
function nameAtlas(names) {
  const rows = Math.ceil(names.length / CELL.cols)
  const canvas = document.createElement('canvas')
  canvas.width = CELL.w * CELL.cols
  canvas.height = CELL.h * rows
  const ctx = canvas.getContext('2d')
  const rand = mulberry32(7717)
  ctx.fillStyle = WOOD
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y += 2) {
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '60,35,15' : '190,150,100'},${0.05 + rand() * 0.12})`
    ctx.fillRect(0, y, canvas.width, 1 + Math.floor(rand() * 2))
  }
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  names.forEach((name, i) => {
    const cx = (i % CELL.cols) * CELL.w
    const cy = Math.floor(i / CELL.cols) * CELL.h
    let size = 38
    ctx.font = `bold ${size}px Georgia, serif`
    // The text keeps clear of the arrow's tip, which takes the cell's right end.
    const room = CELL.w * (1 - SIGN.board.tip / SIGN.board.len) - 24
    while (ctx.measureText(name).width > room && size > 16) ctx.font = `bold ${--size}px Georgia, serif`
    ctx.fillText(name, cx + 12 + room / 2, cy + CELL.h / 2 + 2)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return { texture, rows }
}

// Plain arrays for one mesh in the prop layout.
function propArrays() {
  return { position: [], normal: [], uvProj: [], texLayer: [], color: [], index: [] }
}

function addGeometry(out, g, m, layer, tint) {
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const base = out.position.length / 3
  const v = new THREE.Vector3()
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m)
    out.position.push(v.x, v.y, v.z)
    const px = v.x, py = v.y, pz = v.z
    v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize()
    out.normal.push(v.x, v.y, v.z)
    // Box-projected along the dominant normal axis, in metres.
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z)
    out.uvProj.push(...(ay >= ax && ay >= az ? [px, pz] : ax >= az ? [pz, py] : [px, py]))
    out.texLayer.push(layer)
    out.color.push(...tint)
  }
  const idx = g.index ? g.index.array : Array.from({ length: p.count }, (_, i) => i)
  for (const k of idx) out.index.push(base + k)
}

function toGeometry(a) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.normal, 3))
  if (a.uvProj) g.setAttribute('uvProj', new THREE.Float32BufferAttribute(a.uvProj, 2))
  if (a.texLayer) g.setAttribute('texLayer', new THREE.Float32BufferAttribute(a.texLayer, 1))
  if (a.color) g.setAttribute('color', new THREE.Float32BufferAttribute(a.color, 3))
  if (a.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2))
  g.setIndex(a.index)
  g.computeBoundingSphere()
  return g
}

// One arrow board along +x from the post's face, its faces mapped to atlas cell `cell`: the front reads left to right, the back mirrored so it reads too.
function addBoard(out, m, u0, v0, du, dv) {
  const { len, h, t, tip } = SIGN.board
  const x0 = SIGN.post.w / 2
  const outline = [[x0, -h / 2], [len - tip, -h / 2], [len, 0], [len - tip, h / 2], [x0, h / 2]]
  const v = new THREE.Vector3()
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  const push = (x, y, z, nx, ny, nz, u, w) => {
    v.set(x, y, z).applyMatrix4(m)
    out.position.push(v.x, v.y, v.z)
    v.set(nx, ny, nz).applyMatrix3(nm).normalize()
    out.normal.push(v.x, v.y, v.z)
    out.uv.push(u, w)
    return out.position.length / 3 - 1
  }
  const uvAt = (x, y, flip) => [u0 + du * (flip ? 1 - x / len : x / len), v0 + dv * (y / h + 0.5)]
  for (const side of [1, -1]) {
    const ids = outline.map(([x, y]) => push(x, y, (side * t) / 2, 0, 0, side, ...uvAt(x, y, side < 0)))
    for (let k = 1; k < ids.length - 1; k++) out.index.push(...(side > 0 ? [ids[0], ids[k], ids[k + 1]] : [ids[0], ids[k + 1], ids[k]]))
  }
  // The edges, on a strip of bare wood from the cell's left margin.
  for (let k = 0; k < outline.length; k++) {
    const [ax, ay] = outline[k]
    const [bx, by] = outline[(k + 1) % outline.length]
    const nx = by - ay
    const ny = -(bx - ax)
    const nl = Math.hypot(nx, ny)
    const e = [[ax, ay, t / 2], [bx, by, t / 2], [bx, by, -t / 2], [ax, ay, -t / 2]].map(([x, y, z]) => push(x, y, z, nx / nl, ny / nl, 0, u0 + du * 0.01, v0 + dv * 0.1))
    out.index.push(e[0], e[2], e[1], e[0], e[3], e[2])
  }
}

export class Signposts {
  /** `signs` from planRoads, `names` the towns' names by town index, `field.heightAt` for the ground. */
  constructor(scene, { signs, names, field, textures, patch }) {
    this.scene = scene
    this.signs = signs.map((s) => ({ ...s, group: null }))
    this.field = field
    this.material = createPropMaterial(textures, { vertexColors: true })
    this.material.side = THREE.FrontSide
    patch(this.material, 'v2-sign-post')
    const { texture, rows } = nameAtlas(names)
    this.atlas = { texture, rows }
    this.boardMaterial = new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide })
    patch(this.boardMaterial, 'v2-sign-board')
    this.stone = new THREE.IcosahedronGeometry(1, 0)
    this.stats = { signs: signs.length, shown: 0 }
  }

  _build(s) {
    const rand = mulberry32(s.seed)
    const y = this.field.heightAt(s.x, s.z)
    const group = new THREE.Group()
    group.position.set(s.x, y, s.z)
    const prop = propArrays()
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    // The cairn: a ring of stones round the post's foot and a few more on top of them.
    const { stones, r } = SIGN.cairn
    for (let k = 0; k < stones; k++) {
      const top = k >= stones - 4
      const a = (k / (top ? 4 : stones - 4)) * Math.PI * 2 + rand() * 0.5
      const rr = (top ? 0.2 : r) * (0.85 + rand() * 0.3)
      const size = (top ? 0.16 : 0.22) * (0.8 + rand() * 0.5)
      q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3))
      m.compose(new THREE.Vector3(Math.cos(a) * rr, top ? 0.36 : size * 0.45, Math.sin(a) * rr), q, new THREE.Vector3(size * (1 + rand() * 0.4), size * 0.75, size))
      const g = 0.45 + rand() * 0.2
      addGeometry(prop, this.stone, m, LAYER.ROCK, [g, g * 0.98, g * 0.94])
    }
    // The post, leaning a little.
    const { h, w } = SIGN.post
    const lean = new THREE.Quaternion().setFromEuler(e.set((rand() - 0.5) * 0.06, rand() * Math.PI, (rand() - 0.5) * 0.06))
    const post = new THREE.BoxGeometry(w, h, w)
    m.compose(new THREE.Vector3(0, h / 2 - 0.25, 0), lean, new THREE.Vector3(1, 1, 1))
    addGeometry(prop, post, m, LAYER.TIMBER_HEWN, [0.62, 0.5, 0.4])
    post.dispose()
    group.add(new THREE.Mesh(toGeometry(prop), this.material))
    // The boards, top down nearest first, each turned to its road and tilted a touch.
    const boards = { position: [], normal: [], uv: [], index: [] }
    const du = 1 / CELL.cols
    const dv = 1 / this.atlas.rows
    s.boards.forEach((b, k) => {
      const i = b.town
      const u0 = (i % CELL.cols) * du
      const v0 = 1 - (Math.floor(i / CELL.cols) + 1) * dv
      q.setFromEuler(e.set((rand() - 0.5) * 0.08, -b.angle, 0, 'YXZ'))
      m.compose(new THREE.Vector3(0, SIGN.board.top - k * SIGN.board.gap, 0), q, new THREE.Vector3(1, 1, 1))
      addBoard(boards, m, u0, v0, du, dv)
    })
    group.add(new THREE.Mesh(toGeometry(boards), this.boardMaterial))
    group.name = `signpost-${s.node}`
    this.scene.add(group)
    s.group = group
  }

  _drop(s) {
    this.scene.remove(s.group)
    for (const mesh of s.group.children) mesh.geometry.dispose()
    s.group = null
  }

  update(x, z) {
    let shown = 0
    for (const s of this.signs) {
      const d = Math.hypot(s.x - x, s.z - z)
      if (s.group === null && d < SIGN.near) this._build(s)
      else if (s.group !== null && d > SIGN.far) this._drop(s)
      if (s.group !== null) shown++
    }
    this.stats.shown = shown
  }

  dispose() {
    for (const s of this.signs) if (s.group !== null) this._drop(s)
    this.stone.dispose()
    this.atlas.texture.dispose()
    this.material.dispose()
    this.boardMaterial.dispose()
  }
}
