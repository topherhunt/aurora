/* global AFRAME */
// questv3's feature-toggle panel -- lightweight equivalents of /quest's stress
// categories (terrain, prop counts, materials, lighting, reflections, sky),
// reimplemented directly against the THREE.Scene A-Frame already owns
// (AFRAME.THREE) instead of porting quest-main.js's asset pipeline (texture
// arrays, tree-bank impostor baking, loadImageLayers) wholesale. That
// pipeline is never implicated in the VR-entry failure under investigation --
// it only ever ran in flatscreen mode on /quest, well before ENTER VR was
// clicked. What's being tested here is the same KIND of load (draw-call
// count, procedural geometry, alpha-tested textures, dynamic lighting,
// cubemap reflection, a per-frame-updating sky) but built the way A-Frame
// wants things built, so a toggle that breaks VR entry here is a smoking gun
// pointing at that category, filtered through an architecture already known
// to enter VR successfully.
//
// Interaction is manual raycasting against a group of plain THREE meshes,
// not A-Frame's cursor/raycaster components -- this mirrors exactly what
// quest-main.js already did (clickAt() / controller 'select' listeners) and
// avoids needing every panel button to be its own <a-entity> with a
// registered click listener.

const THREE = AFRAME.THREE

function hash(x, z) { const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return n - Math.floor(n) }
function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), u), THREE.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v)
}
function elevation(x, z) { return (noise(x * .035, z * .035) - .5) * 8 + (noise(x * .14, z * .14) - .5) * 2 + (noise(x * .56, z * .56) - .5) * .5 }

// A simple green-disc-on-brown-stem cross billboard, canvas-drawn once and
// reused -- the same "alpha-tested textured card" category /quest's
// billboard toggle stresses, just without the real tree-bank atlas.
function billboardTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, 128, 128)
  ctx.fillStyle = '#6b4a2f'; ctx.fillRect(58, 88, 12, 40)
  ctx.fillStyle = '#2f7d3a'
  ctx.beginPath(); ctx.arc(64, 52, 44, 0, Math.PI * 2); ctx.fill()
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Color-coded perf readout, ported from quest-main.js's statsTexture() --
// world-space, so it's actually visible in the headset (the flat #stats DOM
// overlay isn't part of the WebXR-presented view at all).
function statsTexture(tris, fps, info, width = 768, height = 150) {
  const c = document.createElement('canvas'); c.width = width; c.height = height
  const ctx = c.getContext('2d')
  ctx.font = 'bold 28px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  const row = (y, segments) => {
    let x = 18
    for (const [label, value, color] of segments) {
      ctx.fillStyle = color
      const prefix = `${label}: `
      ctx.fillText(prefix, x, y)
      x += ctx.measureText(prefix).width
      ctx.fillStyle = '#ffffff'
      const text = String(value)
      ctx.fillText(text, x, y)
      x += ctx.measureText(text).width + 40
    }
  }
  row(height * .32, [['TRIS', tris, '#7fd7ff'], ['FPS', fps, '#ffd27a']])
  row(height * .74, [['CALLS', info.render.calls, '#ff9a7a'], ['GEO', info.memory.geometries, '#b39ddb'], ['TEX', info.memory.textures, '#8fd48f']])
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

function labelTexture(text, bg = '#173154', fg = '#ffffff', width = 384) {
  const c = document.createElement('canvas'); c.width = width; c.height = 96
  const ctx = c.getContext('2d')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = fg; ctx.font = 'bold 28px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
  ctx.fillText(text, c.width / 2, 48)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

AFRAME.registerComponent('quest-features', {
  init() {
    const sceneEl = this.el
    const scene3D = sceneEl.object3D
    const state = {
      billboardCount: 0, treeCount: 0, boulderCount: 0,
      inward: false, masked: true, terrain: false, lit: false,
      lakes: false, reflection: false, sky: false, treeMode: 'individual',
      billboardMode: 'individual',
    }

    const content = new THREE.Group()
    scene3D.add(content)
    const billboardTex = billboardTexture()

    const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x34402b, 1.4)
    scene3D.add(hemi)
    const sunDir0 = new THREE.Vector3(-0.5, 0.5, 0.70710678).normalize()
    const sun = new THREE.DirectionalLight(0xfff0d2, 2.2)
    sun.visible = false
    sun.position.copy(sunDir0).multiplyScalar(50)
    scene3D.add(sun)

    let cubeTarget = null
    let cubeCamera = null
    let clockT = 0
    const skyEl = document.querySelector('a-sky')

    const side = () => (state.inward ? THREE.DoubleSide : THREE.FrontSide)

    function clearContent() {
      while (content.children.length) {
        const o = content.children.pop()
        o.traverse((n) => { if (n.geometry !== billboardGeometry) n.geometry?.dispose(); if (n.material && n.material !== billboardMaterial) n.material.dispose?.() })
      }
    }

    const billboardMaterial = new THREE.MeshBasicMaterial({ map: billboardTex, transparent: true, alphaTest: .5, side: THREE.FrontSide })
    const billboardGeometry = new THREE.PlaneGeometry(1, 1)

    function makeTerrain() {
      const Material = state.lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial
      if (!state.terrain) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new Material({ color: 0x5c7a4a, side: side() }))
        m.rotation.x = -Math.PI / 2
        return m
      }
      const n = 48, size = 48, positions = [], indices = []
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
          const px = (x / (n - 1) - .5) * size
          const pz = (z / (n - 1) - .5) * size
          positions.push(px, elevation(px, pz), pz)
        }
      }
      for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) { const a = z * n + x, b = a + 1, c = a + n, d = c + 1; indices.push(a, c, b, b, c, d) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      g.setIndex(indices)
      g.computeVertexNormals()
      return new THREE.Mesh(g, new Material({ color: 0x5c7a4a, side: side() }))
    }
    const heightAt = (x, z) => (state.terrain ? elevation(x, z) : 0)

    const ARENA_HALF = 20
    function scatterXZ(i, salt) {
      const x = (hash(i, salt) * 2 - 1) * ARENA_HALF
      const z = (hash(i, salt + 1) * 2 - 1) * ARENA_HALF - 4 // bias away from spawn/panel
      return [x, z]
    }

    // Trunk + crown built as two triangle-cone primitives -- geometry cheap
    // enough that count is what stresses draw calls, not vertex cost.
    function treeGeometryPair() {
      const trunk = new THREE.CylinderGeometry(.08, .12, .8, 6)
      trunk.translate(0, .4, 0)
      const crown = new THREE.ConeGeometry(.55, 1.1, 8)
      crown.translate(0, 1.15, 0)
      return { trunk, crown }
    }
    const treeMaterialLit = new THREE.MeshLambertMaterial({ color: 0x3d6b2f })
    const treeMaterialFlat = new THREE.MeshBasicMaterial({ color: 0x3d6b2f })
    const trunkMaterial = new THREE.MeshBasicMaterial({ color: 0x5a3c22 })

    function placeTrees() {
      if (state.treeCount === 0) return
      const placements = []
      for (let i = 0; i < state.treeCount; i++) {
        const [x, z] = scatterXZ(i, 20)
        placements.push({ x, y: heightAt(x, z), z, rotY: hash(i, 24) * Math.PI * 2, scale: .8 + hash(i, 25) * .6 })
      }
      const crownMat = state.lit ? treeMaterialLit : treeMaterialFlat
      if (state.treeMode === 'individual') {
        for (const p of placements) {
          const { trunk, crown } = treeGeometryPair()
          const trunkMesh = new THREE.Mesh(trunk, trunkMaterial)
          const crownMesh = new THREE.Mesh(crown, crownMat)
          const group = new THREE.Group()
          group.add(trunkMesh, crownMesh)
          group.position.set(p.x, p.y, p.z)
          group.rotation.y = p.rotY
          group.scale.setScalar(p.scale)
          content.add(group)
        }
        return
      }
      // instanced: one InstancedMesh per part, hardware-instanced matrices --
      // trades per-tree draw calls (and JS-side object churn) for two total.
      const { trunk, crown } = treeGeometryPair()
      const trunkIM = new THREE.InstancedMesh(trunk, trunkMaterial, placements.length)
      const crownIM = new THREE.InstancedMesh(crown, crownMat, placements.length)
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const scaleVec = new THREE.Vector3()
      const pos = new THREE.Vector3()
      placements.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rotY)
        scaleVec.setScalar(p.scale)
        pos.set(p.x, p.y, p.z)
        m4.compose(pos, q, scaleVec)
        trunkIM.setMatrixAt(i, m4)
        crownIM.setMatrixAt(i, m4)
      })
      trunkIM.instanceMatrix.needsUpdate = true
      crownIM.instanceMatrix.needsUpdate = true
      content.add(trunkIM, crownIM)
    }

    function placeBillboards() {
      if (state.billboardCount === 0) return
      const mat = billboardMaterial.clone()
      mat.alphaTest = state.masked ? .5 : 0
      mat.side = side()
      // individual: every billboard is its own draw call, sharing one
      // geometry/material -- the pre-existing per-instance material clones
      // were pure waste (nothing about them varied per billboard).
      // instanced: one InstancedMesh, one draw call total, same tradeoff as
      // the tree render-mode toggle. Note there's no 'batched' option here
      // (unlike a real THREE.BatchedMesh) -- the three.js build A-Frame 1.5.0
      // bundles predates BatchedMesh, same constraint quest-main.js hit.
      if (state.billboardMode === 'individual') {
        for (let i = 0; i < state.billboardCount; i++) {
          const [x, z] = scatterXZ(i, 10)
          const m = new THREE.Mesh(billboardGeometry, mat)
          m.position.set(x, heightAt(x, z) + .5, z)
          m.rotation.y = hash(i, 12) * Math.PI * 2
          content.add(m)
        }
        return
      }
      const im = new THREE.InstancedMesh(billboardGeometry, mat, state.billboardCount)
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const scaleVec = new THREE.Vector3(1, 1, 1)
      const pos = new THREE.Vector3()
      for (let i = 0; i < state.billboardCount; i++) {
        const [x, z] = scatterXZ(i, 10)
        pos.set(x, heightAt(x, z) + .5, z)
        q.setFromAxisAngle(up, hash(i, 12) * Math.PI * 2)
        m4.compose(pos, q, scaleVec)
        im.setMatrixAt(i, m4)
      }
      im.instanceMatrix.needsUpdate = true
      content.add(im)
    }

    function placeBoulders() {
      const Material = state.lit ? THREE.MeshLambertMaterial : THREE.MeshBasicMaterial
      for (let i = 0; i < state.boulderCount; i++) {
        const [x, z] = scatterXZ(i, 30)
        const scale = .3 + hash(i, 31) * .5
        const g = new THREE.DodecahedronGeometry(1, 0)
        const m = new THREE.Mesh(g, new Material({ color: 0x8a8a86, side: side() }))
        m.scale.setScalar(scale)
        m.position.set(x, heightAt(x, z) + scale * .5, z)
        content.add(m)
      }
    }

    function makeLakes() {
      if (!state.lakes) return
      const lakeGroup = new THREE.Group()
      for (let i = 0; i < 3; i++) {
        const g = new THREE.CircleGeometry((2 + i) * 2, 20)
        const m = new THREE.MeshStandardMaterial({ color: 0x397a9b, roughness: .18, metalness: .05, side: side() })
        const lake = new THREE.Mesh(g, m)
        const a = hash(i, 8) * Math.PI * 2, r = 8 + i * 6
        const x = Math.cos(a) * r, z = Math.sin(a) * r - 4
        lake.rotation.x = -Math.PI / 2
        lake.position.set(x, heightAt(x, z) + .05, z)
        lakeGroup.add(lake)
      }
      lakeGroup.userData.lakes = true
      content.add(lakeGroup)
    }

    function updateReflection() {
      if (!state.reflection) { cubeTarget?.dispose(); cubeTarget = null; cubeCamera = null; return }
      if (!cubeTarget) {
        cubeTarget = new THREE.WebGLCubeRenderTarget(128)
        cubeCamera = new THREE.CubeCamera(.1, 200, cubeTarget)
        scene3D.add(cubeCamera)
      }
      content.traverse((o) => { if (o.userData.lakes) o.children.forEach((lake) => { lake.material.envMap = cubeTarget.texture; lake.material.needsUpdate = true }) })
    }

    function rebuild() {
      clearContent()
      const terrain = makeTerrain()
      terrain.userData.terrain = true
      content.add(terrain)
      placeBillboards()
      placeTrees()
      placeBoulders()
      makeLakes()
      updateReflection()
      updatePanel()
    }

    // --- panel -----------------------------------------------------------
    // World-space, to the left of spawn -- clickable via manual raycasting
    // (mouse on flatscreen, controller pose in VR), same pattern as
    // quest-main.js's own panel.
    const panel = new THREE.Group()
    panel.position.set(-4.0, 1.5, -2.4)
    panel.rotation.y = Math.PI / 7
    scene3D.add(panel)
    const panelMeshes = []
    const panelLabels = []

    const panelBg = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 4.7), new THREE.MeshBasicMaterial({ color: 0x091321, transparent: true, opacity: .92, side: THREE.DoubleSide }))
    panel.add(panelBg)

    function panelButton(key, text, y, opts = {}) {
      const width = opts.width ?? 1.6
      const x = opts.x ?? 0
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, .18), new THREE.MeshBasicMaterial({ map: labelTexture(text, '#173154', '#ffffff', Math.round(width / .18 * 96)), side: THREE.DoubleSide, transparent: true, toneMapped: false }))
      mesh.position.set(x, y, .03)
      mesh.userData.key = key
      panel.add(mesh)
      panelMeshes.push(mesh)
      return mesh
    }
    function panelLabel(text, y) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, .18), new THREE.MeshBasicMaterial({ map: labelTexture(text, '#050a12', '#8fd48f', Math.round(1.9 / .18 * 96)), side: THREE.DoubleSide, transparent: true, toneMapped: false }))
      mesh.position.set(0, y, .04)
      panel.add(mesh)
      panelLabels.push(mesh)
      return mesh
    }
    function setPanelMap(mesh, text, bg = '#173154', fg = '#ffffff') {
      const width = mesh.geometry.parameters.width
      const height = mesh.geometry.parameters.height
      mesh.material.map = labelTexture(text, bg, fg, Math.round(width / height * 96))
      mesh.material.needsUpdate = true
    }

    const panelTitle = new THREE.Mesh(new THREE.PlaneGeometry(1.9, .37), new THREE.MeshBasicMaterial({ map: statsTexture(0, 0, sceneEl.renderer?.info ?? { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } }), side: THREE.DoubleSide, transparent: true, toneMapped: false }))
    panelTitle.position.set(0, 2.10, .04)
    panel.add(panelTitle)

    panelLabel('questv3 feature panel', 1.78)
    const keys = [
      ['billboard+', 'billboards +', 1.50, { width: .76, x: -.42 }], ['billboard-', 'billboards -', 1.50, { width: .76, x: .42 }],
      ['tree+', 'trees +', 1.26, { width: .76, x: -.42 }], ['tree-', 'trees -', 1.26, { width: .76, x: .42 }],
      ['boulder+', 'boulders +', 1.02, { width: .76, x: -.42 }], ['boulder-', 'boulders -', 1.02, { width: .76, x: .42 }],
      ['treeMode', 'tree render: individual', .74],
      ['billboardMode', 'billboard render: individual', .46],
      ['terrain', 'terrain: flat', .18],
      ['lighting', 'lighting: off', -.10],
      ['masked', 'masked alpha: on', -.38],
      ['inward', 'inward faces: off', -.66],
      ['lakes', 'lake pools: off', -.94],
      ['reflection', 'cubemap reflection: off', -1.22],
      ['sky', 'sky + day/night: off', -1.50],
    ]
    for (const [key, text, y, opts] of keys) panelButton(key, text, y, opts)

    function updatePanel() {
      for (const m of panelMeshes) {
        const k = m.userData.key
        let t = null
        if (k === 'treeMode') t = `tree render: ${state.treeMode}`
        if (k === 'billboardMode') t = `billboard render: ${state.billboardMode}`
        if (k === 'terrain') t = `terrain: ${state.terrain ? 'procedural' : 'flat'}`
        if (k === 'lighting') t = `lighting: ${state.lit ? 'on' : 'off'}`
        if (k === 'masked') t = `masked alpha: ${state.masked ? 'on' : 'off'}`
        if (k === 'inward') t = `inward faces: ${state.inward ? 'on' : 'off'}`
        if (k === 'lakes') t = `lake pools: ${state.lakes ? 'on' : 'off'}`
        if (k === 'reflection') t = `cubemap reflection: ${state.reflection ? 'on' : 'off'}`
        if (k === 'sky') t = `sky + day/night: ${state.sky ? 'on' : 'off'}`
        if (t !== null) setPanelMap(m, t)
      }
      setPanelMap(panelLabels[0], `billboards ${state.billboardCount}  trees ${state.treeCount}  boulders ${state.boulderCount}`, '#050a12', '#8fd48f')
    }

    const CONTENT_KEYS = new Set(['billboard+', 'billboard-', 'tree+', 'tree-', 'boulder+', 'boulder-', 'treeMode', 'billboardMode', 'terrain', 'lighting', 'masked', 'inward', 'lakes', 'reflection'])
    function activate(key) {
      if (key === 'billboard+') state.billboardCount = state.billboardCount === 0 ? 2 : state.billboardCount * 2
      if (key === 'billboard-') state.billboardCount = state.billboardCount <= 1 ? 0 : Math.floor(state.billboardCount / 2)
      if (key === 'tree+') state.treeCount = state.treeCount === 0 ? 2 : state.treeCount * 2
      if (key === 'tree-') state.treeCount = state.treeCount <= 1 ? 0 : Math.floor(state.treeCount / 2)
      if (key === 'boulder+') state.boulderCount = state.boulderCount === 0 ? 2 : state.boulderCount * 2
      if (key === 'boulder-') state.boulderCount = state.boulderCount <= 1 ? 0 : Math.floor(state.boulderCount / 2)
      if (key === 'treeMode') state.treeMode = state.treeMode === 'individual' ? 'instanced' : 'individual'
      if (key === 'billboardMode') state.billboardMode = state.billboardMode === 'individual' ? 'instanced' : 'individual'
      if (key === 'terrain') state.terrain = !state.terrain
      if (key === 'lighting') { state.lit = !state.lit; hemi.intensity = state.lit ? 1.8 : 1.0; sun.visible = state.lit }
      if (key === 'masked') state.masked = !state.masked
      if (key === 'inward') state.inward = !state.inward
      if (key === 'lakes') state.lakes = !state.lakes
      if (key === 'reflection') state.reflection = !state.reflection
      if (key === 'sky') state.sky = !state.sky

      if (CONTENT_KEYS.has(key)) rebuild()
      else updatePanel()
    }

    // --- input: mouse (flatscreen) + controller pose (VR) -----------------
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const temp = new THREE.Vector3()
    const tempQuat = new THREE.Quaternion()

    function clickAt(clientX, clientY) {
      const camera = sceneEl.camera
      if (!camera) return
      pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(panelMeshes)[0]
      if (hit) activate(hit.object.userData.key)
    }
    window.addEventListener('pointerup', (e) => { if (!sceneEl.is('vr-mode')) clickAt(e.clientX, e.clientY) })

    // laser-controls entities are declared in the HTML (hand: left/right,
    // nested under #rig -- see questv3.html). Each frame we raycast every
    // controller against the panel (updateControllerHover, called from
    // tick()) and park the result on `entry.hit`; a small red dot mesh
    // tracks the hit point so the laser visibly stops on a button instead of
    // passing through, and 'triggerdown' just activates whatever that same
    // hover already found -- one hit-test feeds both the visual and the
    // click, instead of two separate raycasts that could disagree.
    const dotGeometry = new THREE.SphereGeometry(.012, 12, 8)
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false, depthTest: false })
    const controllerHits = new Map() // el -> { hit, dot }
    function wireController(el) {
      const dot = new THREE.Mesh(dotGeometry, dotMaterial)
      dot.visible = false
      scene3D.add(dot)
      controllerHits.set(el, { hit: null, dot })
      el.addEventListener('triggerdown', () => {
        const hit = controllerHits.get(el)?.hit
        if (hit) activate(hit.object.userData.key)
      })
    }
    sceneEl.querySelectorAll('[laser-controls]').forEach(wireController)
    // laser-controls composes its own 'raycaster' component on this same
    // entity once the controller connects, with an origin/direction A-Frame
    // configures per controller profile (e.g. oculus-touch-controls nudges
    // it to match the physical laser drawn by that component's line) -- that
    // won't generally match a bare (0,0,-1) cast off the raw entity
    // transform. Reusing that component's own THREE.Raycaster guarantees our
    // hit-test lines up with the laser the player actually sees, instead of
    // us re-deriving an approximation of it.
    function updateControllerHover() {
      for (const [el, entry] of controllerHits) {
        const raycasterComp = el.components.raycaster
        let hit = null
        if (raycasterComp) {
          hit = raycasterComp.raycaster.intersectObjects(panelMeshes)[0] || null
        } else {
          const obj = el.object3D
          obj.getWorldPosition(temp)
          obj.getWorldQuaternion(tempQuat)
          const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(tempQuat).normalize()
          raycaster.set(temp, direction)
          hit = raycaster.intersectObjects(panelMeshes)[0] || null
        }
        entry.hit = hit
        entry.dot.visible = !!hit
        if (hit) entry.dot.position.copy(hit.point)
      }
    }

    // --- locomotion: thumbstick move/strafe (movement-controls on #rig,
    // declared in the HTML) + A/X button toggles walk vs. fly --------------
    const rigEl = sceneEl.querySelector('#rig')
    let flying = false
    const flyLabel = panelLabel('locomotion: walk (A/X to fly)', -1.78)
    function setFlying(next) {
      flying = next
      rigEl.setAttribute('movement-controls', 'fly', flying)
      setPanelMap(flyLabel, `locomotion: ${flying ? 'fly' : 'walk'} (A/X to toggle)`, '#050a12', '#8fd48f')
    }
    sceneEl.querySelectorAll('[laser-controls]').forEach((el) => {
      el.addEventListener('abuttondown', () => setFlying(!flying))
      el.addEventListener('xbuttondown', () => setFlying(!flying))
    })

    // --- stats overlay: same readout /quest's #stats shows -----------------
    const statsEl = document.getElementById('stats')
    // InstancedMesh's own .geometry is the ONE shared shape -- its per-triangle
    // cost has to be multiplied by .count, or turning on 'instanced' tree mode
    // would misreport as if only one tree existed.
    function triangles() {
      let n = 0
      content.traverse((o) => {
        if (!o.isMesh || !o.geometry) return
        const g = o.geometry
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3
        n += o.isInstancedMesh ? tris * o.count : tris
      })
      return n
    }
    let fps = 0, fpsFrames = 0, fpsAt = performance.now()

    // --- sky + day/night: a slow color/light cycle, the per-frame-update
    // category /quest's sky toggle stresses (WorldClock/Sky/Stars, simplified
    // to a color lerp + rotating sun direction) -----------------------------
    this.tick = (_t, dtMs) => {
      updateControllerHover()
      fpsFrames++
      const nowMs = performance.now()
      if (nowMs - fpsAt >= 500) {
        fps = Math.round((fpsFrames * 1000) / (nowMs - fpsAt)); fpsFrames = 0; fpsAt = nowMs
        if (sceneEl.renderer) {
          const info = sceneEl.renderer.info
          const tris = triangles()
          if (statsEl) statsEl.innerHTML = `triangles: ${tris.toLocaleString()}\nFPS: ${fps}\ndraw calls: ${info.render.calls}\ngeometries: ${info.memory.geometries}  textures: ${info.memory.textures}\n${sceneEl.is('vr-mode') ? 'XR: presenting' : 'XR: inline'}`
          // the flat #stats div isn't visible inside the WebXR view -- this
          // world-space readout on the panel is what's actually seen in headset
          panelTitle.material.map?.dispose()
          panelTitle.material.map = statsTexture(tris, fps, info)
          panelTitle.material.needsUpdate = true
        }
      }
      if (!state.sky) return
      clockT += dtMs / 1000
      const cyclePos = (clockT / 40) % 1 // 40s full day/night loop
      const angle = cyclePos * Math.PI * 2
      const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle) * .8 + .3, .5).normalize()
      sun.position.copy(dir).multiplyScalar(50)
      sun.visible = true
      const dayness = THREE.MathUtils.clamp(dir.y, 0, 1)
      const dayColor = new THREE.Color(0x9db4cf)
      const nightColor = new THREE.Color(0x0a1226)
      const skyColor = nightColor.clone().lerp(dayColor, dayness)
      if (skyEl) skyEl.setAttribute('color', `#${skyColor.getHexString()}`)
      hemi.intensity = THREE.MathUtils.lerp(.4, 1.8, dayness)
      if (cubeCamera && Math.floor(clockT * 10) % 5 === 0) {
        content.traverse((o) => { if (o.userData.lakes) o.children.forEach((l) => { l.visible = false }) })
        cubeCamera.update(sceneEl.renderer, sceneEl.object3D)
        content.traverse((o) => { if (o.userData.lakes) o.children.forEach((l) => { l.visible = true }) })
      }
    }

    rebuild()
  },
})
