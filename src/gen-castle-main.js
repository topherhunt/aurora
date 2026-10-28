// The castle lab (gen-castle.html): one seed's layout as its exterior, or its rooms at INNER with storeys cut away, under the
// path graph drawn on top in the style of pocket-game's v5 lab. Both views share the graph, scaled, so a door outside is the door inside.
import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { grassTexture } from './preview-stage.js'
import { CASTLE, castleLayout } from './v2/castles/layout.js'
import { courtGeometry, exteriorGeometry, interiorGeometries, toGeometry, UV_METRES } from './v2/castles/shell.js'

const EDGE = { door: '#ffffff', gate: '#ffffff', stair: '#3fd0ff', ladder: '#a8ffff', outstair: '#ffd23f', step: '#9be564', bridge: '#ff9d3f', rope: '#ff6fcf', barred: '#ff3b3b' }
const NODE = { entry: '#ffffff', court: '#9be564', walk: '#ffd23f', roof: '#ff9d3f', summit: '#ffdf00', keep: '#6fa8ff', hall: '#b48cff', gate: '#d0d0d0', tower: '#5fd3c4', lookout: '#ff6f6f' }
const ROUTE = '#ff40ff'
const nodeColour = (n) => NODE[n.kind === 'room' ? n.sec.kind : n.kind]

const params = new URLSearchParams(location.search)
let seed = Number(params.get('seed') ?? 1) | 0
let inside = params.get('view') === 'int'
let cut = Infinity, ghostOn = false, graphOn = true, labelsOn = true, routeOn = true, spin = false
let lay = null

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const SKY = new THREE.Color(0x8fb4d8), VOID = new THREE.Color(0x10151f)
scene.background = SKY.clone()
scene.fog = new THREE.Fog(scene.background, 160, 420)
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1200)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.autoRotateSpeed = 0.6
const sun = new THREE.DirectionalLight(0xfff3e2, 2.2)
sun.position.set(40, 70, 25)
scene.add(sun, new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.9))

const loadTile = (path, metres) => {
  const t = new THREE.TextureLoader().load(path, undefined, undefined, (e) => { throw new Error(`castle lab: ${path} failed to load: ${e}`) })
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  t.repeat.setScalar(UV_METRES / metres)
  return t
}
// Shell geometry carries a group per material slot (shell.js SLOTS) with UVs already in each slot's tile metres.
const stoneMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: loadTile('/buildings/castle_stone.webp', UV_METRES) })
const plankMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: loadTile('/buildings/timber_plank.png', UV_METRES) })
const doorMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: loadTile('/buildings/door.png', UV_METRES) })
const material = [stoneMat, plankMat, doorMat]
// Interior metres per exterior metre on each axis.
const INNER = new THREE.Vector3(CASTLE.scale, CASTLE.tall, CASTLE.scale)
// The road's flagstones, 3 m a tile (COBBLE_METRES in terrain-material.js).
const courtMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: loadTile('/terrain/cobble.webp', 3) })
const court = new THREE.Mesh(new THREE.BufferGeometry(), courtMat)
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x9fc6ff, transparent: true, opacity: 0.1, depthWrite: false, wireframe: false })
const exterior = new THREE.Mesh(new THREE.BufferGeometry(), material)
const ghost = new THREE.Mesh(exterior.geometry, ghostMat)
ghost.scale.copy(INNER)
const interior = new THREE.Group()
const overlay = new THREE.Group()
scene.add(exterior, ghost, court, interior, overlay)

// A hilltop: flat CASTLE.raise below the castle's floor where it stands, falling away past it.
const hillGeo = new THREE.PlaneGeometry(800, 800, 160, 160).rotateX(-Math.PI / 2)
const grass = grassTexture(renderer)
grass.repeat.set(160, 160)
const hill = new THREE.Mesh(hillGeo, new THREE.MeshLambertMaterial({ map: grass }))
scene.add(hill)
function shapeHill(radius) {
  const p = hillGeo.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getZ(i)) - radius
    p.setY(i, -CASTLE.raise - (r < 0 ? 0 : Math.min(60, r * r * 0.01 + r * 0.15)))
  }
  p.needsUpdate = true
  hillGeo.computeVertexNormals()
}

function label(text, colour) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d')
  ctx.font = 'bold 26px monospace'
  c.width = ctx.measureText(text).width + 16
  c.height = 38
  ctx.font = 'bold 26px monospace'
  ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = colour; ctx.fillText(text, 8, 28)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }))
  sp.scale.set(0.011 * c.width / c.height, 0.011, 1)
  sp.renderOrder = 12
  return sp
}

const routeMat = new LineMaterial({ color: ROUTE, linewidth: 5, transparent: true, opacity: 0.55, depthTest: false })
function disposeTree(g) {
  for (const o of [...g.children]) {
    g.remove(o)
    if (!o.isSprite) o.geometry.dispose()
    if (o.material === routeMat || o.material === material) continue
    if (o.material.map) o.material.map.dispose()
    o.material.dispose()
  }
}

/** The graph over whichever view is up: lines along each edge's real route, a ball and a label per node, the route fat on top. */
function buildOverlay() {
  disposeTree(overlay)
  if (inside) overlay.scale.copy(INNER); else overlay.scale.setScalar(1)
  if (!graphOn) return
  const shown = (n) => !n.unused && (!inside || n.k <= cut)
  const step = new Map(routeOn ? lay.route.nodes.map((n, i) => [n, i]) : [])
  for (const e of lay.edges) {
    if (!shown(e.a) || !shown(e.b)) continue
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(e.pts.map((p) => new THREE.Vector3(...p))),
      new THREE.LineBasicMaterial({ color: EDGE[e.kind], depthTest: false, transparent: true, opacity: 0.85 }))
    line.renderOrder = 10
    overlay.add(line)
    if (routeOn && e.onRoute) {
      const g = new LineGeometry().setPositions(e.pts.flat())
      const fat = new Line2(g, routeMat)
      fat.renderOrder = 9
      overlay.add(fat)
    }
  }
  for (const n of lay.nodes) {
    if (!shown(n)) continue
    const r = n.kind === 'summit' ? 0.8 : n.out ? 0.45 : 0.35
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: nodeColour(n), depthTest: false }))
    ball.position.set(...n.pos)
    ball.renderOrder = 11
    overlay.add(ball)
    if (!labelsOn) continue
    const name = n.kind === 'room' ? n.id : n.kind === n.id ? n.id : `${n.id} ${n.kind}`
    const sp = label(step.has(n) ? `${step.get(n)} ${name}` : name, nodeColour(n))
    sp.position.set(n.pos[0], n.pos[1] + 0.9, n.pos[2])
    overlay.add(sp)
  }
}

function buildInterior() {
  disposeTree(interior)
  for (const { k, geometry, low } of interiorGeometries(lay)) {
    for (const [g, isLow] of [[geometry, false], [low, true]]) {
      const m = new THREE.Mesh(toGeometry(g), material)
      m.userData = { k, low: isLow }
      interior.add(m)
    }
  }
}

const tris = (g) => g.getAttribute('position').count / 3
function applyView() {
  exterior.visible = !inside
  hill.visible = court.visible = !inside
  ghost.visible = inside && ghostOn
  interior.visible = inside
  // The cut storey draws its waist-high twin so its floor plan reads from above.
  for (const m of interior.children) m.visible = m.userData.low ? m.userData.k === cut : m.userData.k < cut
  scene.background.copy(inside ? VOID : SKY)
  scene.fog.color.copy(scene.background)
  document.getElementById('view').textContent = inside ? 'interior' : 'exterior'
  document.getElementById('view').classList.toggle('on', inside)
  const top = Math.max(...lay.sections.map((s) => s.floors))
  const cutEl = document.getElementById('cut')
  cutEl.max = top
  cutEl.value = Math.min(cut, top)
  document.getElementById('cutLabel').textContent = cut >= top ? 'all' : `${cut}`
  buildOverlay()
  const u = new URL(location.href)
  u.searchParams.set('seed', seed)
  if (inside) u.searchParams.set('view', 'int'); else u.searchParams.delete('view')
  history.replaceState(null, '', u)
}

function renderPanel() {
  const st = lay.stats
  const intTris = interior.children.filter((m) => !m.userData.low).reduce((a, m) => a + tris(m.geometry), 0)
  const kinds = Object.entries(st.kinds).sort().map(([k, v]) => `${k} ${v}`).join(', ')
  const secs = Object.entries(st.sections).sort().map(([k, v]) => `${k} ${v}`).join(', ')
  const rows = [
    ['verdict', `<span class="${st.ok ? 'pass' : 'fail'}">${st.ok ? 'PASS' : 'FAIL'}</span>`],
    ['court', `${lay.cw} x ${lay.cd} cells`],
    ['sections', secs],
    ['rooms', st.rooms],
    ['outdoor nodes', st.outdoor],
    ['edges / candidates', `${st.edges} / ${st.candidates}`],
    ['edge kinds', kinds],
    ['route edges', st.routeEdges],
    ['in/out switches', st.switches],
    ['descents', st.descents],
    ['dead-end rooms', st.deadEnds],
    ['loops', st.loops],
    ['stranded', st.stranded],
    ['layout ms', st.ms.toFixed(1)],
    ['exterior tris', tris(exterior.geometry)],
    ['interior tris', intTris],
  ]
  document.getElementById('statsTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`).join('')
  const ns = lay.route.nodes, es = lay.route.edges
  document.getElementById('routeList').innerHTML = ns.map((n, i) => `<li><span style="color:${nodeColour(n)}">${n.id}</span>${i ? ` <small>by ${es[i - 1].kind}</small>` : ''}</li>`).join('')
}

function legend() {
  const sw = (c, t) => `<b style="color:${c}">&#9632;</b> ${t}`
  document.getElementById('legend').innerHTML =
    `edges: ${Object.entries(EDGE).filter(([k]) => k !== 'gate').map(([k, c]) => sw(c, k)).join(' &middot; ')} &middot; ${sw(ROUTE, 'route')}<br>` +
    `nodes: ${Object.entries(NODE).map(([k, c]) => sw(c, k)).join(' &middot; ')}`
}

function rebuild() {
  lay = castleLayout(seed)
  exterior.geometry.dispose()
  exterior.geometry = ghost.geometry = toGeometry(exteriorGeometry(lay))
  court.geometry.dispose()
  court.geometry = toGeometry(courtGeometry(lay))
  buildInterior()
  const r = Math.max(...lay.sections.flatMap((s) => [[s.x0, s.z0], [s.x0 + s.w, s.z0], [s.x0, s.z0 + s.d], [s.x0 + s.w, s.z0 + s.d]].map(([x, z]) => Math.hypot(lay.X(x), lay.Z(z)))))
  shapeHill(r + 10)
  // Frame the whole castle, summit included, from the front-right.
  const f = inside ? CASTLE.scale : 1, top = lay.nodes.find((n) => n.kind === 'summit').pos[1]
  controls.target.set(0, top * 0.4 * f, 0)
  camera.position.set(0.55, 0.45, 0.75).normalize().multiplyScalar(Math.max(r, top) * 2.3 * f).add(controls.target)
  cut = Infinity
  document.getElementById('seed').value = seed
  applyView()
  renderPanel()
}

/** Flip inside/outside, scaling the camera about the castle's centre so the same doorway stays framed. */
function flip() {
  const f = inside ? new THREE.Vector3(1, 1, 1).divide(INNER) : INNER
  camera.position.multiply(f)
  controls.target.multiply(f)
  inside = !inside
  applyView()
}

const seedInput = document.getElementById('seed')
seedInput.addEventListener('change', () => { seed = Number(seedInput.value) | 0; rebuild() })
document.getElementById('reroll').addEventListener('click', () => { seed += 1; rebuild() })
document.getElementById('prev').addEventListener('click', () => { seed = Math.max(0, seed - 1); rebuild() })
document.getElementById('view').addEventListener('click', flip)
const cutEl = document.getElementById('cut')
cutEl.addEventListener('input', () => { const v = Number(cutEl.value); cut = v >= Number(cutEl.max) ? Infinity : v; applyView() })
const toggle = (id, fn) => {
  const b = document.getElementById(id)
  b.addEventListener('click', () => { b.classList.toggle('on'); fn(b.classList.contains('on')) })
}
toggle('ghost', (on) => { ghostOn = on; applyView() })
toggle('graph', (on) => { graphOn = on; buildOverlay() })
toggle('labels', (on) => { labelsOn = on; buildOverlay() })
toggle('route', (on) => { routeOn = on; buildOverlay() })
toggle('wire', (on) => { for (const m of material) m.wireframe = on })
toggle('spin', (on) => { spin = on })
addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return
  if (ev.key === 'i') flip()
  else if (ev.key === 'r') { seed += 1; rebuild() }
  else if (ev.key === '[' || ev.key === ']') {
    const top = Number(cutEl.max), cur = Math.min(cut, top)
    const next = Math.max(0, Math.min(top, cur + (ev.key === ']' ? 1 : -1)))
    cut = next >= top ? Infinity : next
    applyView()
  }
})

function resize() {
  renderer.setSize(stage.clientWidth, stage.clientHeight)
  camera.aspect = stage.clientWidth / stage.clientHeight
  camera.updateProjectionMatrix()
  routeMat.resolution.set(stage.clientWidth, stage.clientHeight)
}
addEventListener('resize', resize)
resize()
legend()
rebuild()
if (params.has('cut')) { cut = Number(params.get('cut')); applyView() }

let frames = 0
renderer.setAnimationLoop(() => {
  controls.autoRotate = spin
  controls.update()
  renderer.render(scene, camera)
  if (++frames === 3) window.__shot = true
})
window.castleLab = {
  camera, controls,
  get seed() { return seed }, get inside() { return inside }, get stats() { return lay.stats },
  setSeed(s) { seed = s; rebuild() }, flip, setCut(k) { cut = k; applyView() },
}
