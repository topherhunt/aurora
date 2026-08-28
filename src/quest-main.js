/* global AFRAME */
// /quest, rearchitected onto the same A-Frame bootstrap as /questv3 (see
// questv3-main.js for why: A-Frame's own session/reference-space handling
// reliably enters VR on-device, where the old hand-rolled WebXR bootstrap in
// this file's previous version never did). This keeps /quest's REAL content
// pipeline -- texture arrays, tree-bank impostor baking, rock-bank geometry,
// Sky/Stars/WorldClock -- instead of questv3's simplified stand-ins, wired
// against A-Frame's own THREE.Scene/renderer/camera (AFRAME.THREE) the same
// way questv3-main.js's 'quest-features' component already does.
//
// Locomotion and panel interaction are NOT ported from the old Input/Player/
// XRControls trio -- those existed to hand-roll what A-Frame already provides
// via movement-controls (keyboard) + blink-controls (VR teleport), declared
// on the rig in quest.html, plus an A/X-button fly toggle. Panel clicking is
// manual raycasting against plain THREE meshes (mouse on flatscreen,
// laser-controls' own raycaster component in VR), exactly questv3's pattern.
//
// KNOWN RISK, not yet verified on-device: content geometry/materials here are
// built by tree-bank.js/rock.js/material.js/sky.js/stars.js/clock.js/
// textures.js/preview-stage.js, which all `import * as THREE from 'three'`
// (this project's npm three@0.180.0) -- a different THREE.js MODULE INSTANCE
// than AFRAME.THREE, which is bundled inside A-Frame 1.5.0 (three r150-ish, a
// ~30-revision gap). Basic Object3D/Mesh/BufferGeometry/Material trees are
// usually cross-version safe (three's renderer duck-types via .isMesh etc.,
// not instanceof), and createPropMaterial's onBeforeCompile only touches
// long-stable chunk names (#include <common>/<begin_vertex>/
// <project_vertex>/<normal_fragment_begin>), so this SHOULD work -- but it
// has not been confirmed in-headset. If trees/rocks render black, invisible,
// or throw shader compile errors in the console, this version gap is the
// first suspect.
const THREE = AFRAME.THREE

import { Sky } from './sky.js'
import { Stars } from './stars.js'
import { WorldClock } from './clock.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { buildTreeBank, bakeTreeImpostors } from './props/tree-bank.js'
import { buildRock } from './props/rock.js'
import { ROCK_NAMES, rockParams } from './props/rock-bank.js'
import { createPropMaterial } from './material.js'

function hash(x, z) { const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return n - Math.floor(n) }
function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), u), THREE.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v)
}
function elevation(x, z) { return (noise(x * .035, z * .035) - .5) * 8 + (noise(x * .14, z * .14) - .5) * 2 + (noise(x * .56, z * .56) - .5) * .5 }

function labelTexture(text, bg = '#173154', fg = '#ffffff', width = 384) {
  const c = document.createElement('canvas'); c.width = width; c.height = 96
  const ctx = c.getContext('2d')
  if (bg !== null) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height) }
  ctx.fillStyle = fg; ctx.font = 'bold 28px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = bg === null ? 'left' : 'center'
  ctx.fillText(text, bg === null ? 18 : c.width / 2, 48)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
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

AFRAME.registerComponent('quest-features', {
  init() {
    const sceneEl = this.el
    const scene3D = sceneEl.object3D
    const statsEl = document.getElementById('stats')
    const skyEl = document.querySelector('a-sky')

    const state = {
      billboardCount: 0, treeCount: 0, boulderCount: 0,
      inward: false, masked: true, terrain: false, lit: false, terrainScale: 128, vertices: 64,
      lakes: false, reflection: false, sky: false, treeMode: 'individual', billboardMode: 'individual',
    }

    const content = new THREE.Group()
    scene3D.add(content)

    const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x34402b, 1.8)
    scene3D.add(hemi)
    const sunDir = new THREE.Vector3(-0.5, 0.5, 0.70710678).normalize()
    const sun = new THREE.DirectionalLight(0xfff0d2, 2.2)
    sun.position.copy(sunDir).multiplyScalar(50)
    scene3D.add(sun)

    // Day/night system: off by default (static sun, flat <a-sky>). When on,
    // `clock` drives sun/moon position, sky colour, fog and stars every
    // frame via applySky(); when off, resetSkyVisuals() restores the statics.
    // Deliberately without the aurora (v2/render/aurora.js) -- that's its own
    // expensive draw and not what this toggle is testing.
    const sky = new Sky(scene3D)
    sky.mesh.visible = false
    sky.uniforms.uSunDir.value.copy(sunDir)
    const stars = new Stars(scene3D, { seed: 20260828 })
    const clock = new WorldClock({ seed: 20260828 })
    const setSRGB = (color, rgb) => color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
    const headPos = new THREE.Vector3()
    function resetSkyVisuals() {
      sky.mesh.visible = false
      stars.points.visible = false
      if (skyEl) skyEl.setAttribute('visible', true)
      sun.color.set(0xfff0d2); sun.intensity = 2.2; sun.position.copy(sunDir).multiplyScalar(50)
      hemi.color.set(0xd8e8ff); hemi.groundColor.set(0x34402b); hemi.intensity = 1.8
    }
    function applySky(dt) {
      clock.advance(dt)
      const s = clock.state()
      const camera = sceneEl.camera
      if (camera) camera.getWorldPosition(headPos)
      if (skyEl) skyEl.setAttribute('visible', false) // sky.mesh (the real dome) replaces it while active
      sky.mesh.visible = true
      sky.update(headPos, s)
      stars.update(headPos, s, clock.elapsed, performance.now() / 1000)
      sun.position.copy(s.lightDir).multiplyScalar(50)
      setSRGB(sun.color, s.lightColor)
      sun.intensity = s.lightIntensity
      setSRGB(hemi.color, s.hemiSky)
      setSRGB(hemi.groundColor, s.hemiGround)
      hemi.intensity = s.hemiIntensity
    }

    const side = () => (state.inward ? THREE.DoubleSide : THREE.FrontSide)

    // --- panel -------------------------------------------------------------
    const panel = new THREE.Group()
    panel.position.set(-4.0, 1.6, -2.6)
    scene3D.add(panel)
    const panelMeshes = []
    const panelLabels = []

    function panelButton(key, text, y, opts = {}) {
      const width = opts.width ?? 1.9
      const x = opts.x ?? 0
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, .18), new THREE.MeshBasicMaterial({ map: labelTexture(text, '#173154', '#ffffff', Math.round(width / .18 * 96)), side: THREE.DoubleSide, transparent: true, toneMapped: false }))
      mesh.position.set(x, y, .03)
      mesh.userData.key = key
      panel.add(mesh)
      panelMeshes.push(mesh)
      return mesh
    }
    function panelLabel(text, y) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.1, .18), new THREE.MeshBasicMaterial({ map: labelTexture(text, null, '#8fd48f', Math.round(2.1 / .18 * 96)), transparent: true, toneMapped: false, side: THREE.DoubleSide }))
      mesh.position.set(-.4, y, .04)
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

    const panelBg = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.9), new THREE.MeshBasicMaterial({ color: 0x091321, transparent: true, opacity: .94, side: THREE.DoubleSide }))
    panel.add(panelBg)
    const panelTitle = new THREE.Mesh(new THREE.PlaneGeometry(2.0, .39), new THREE.MeshBasicMaterial({ map: statsTexture(0, 0, sceneEl.renderer?.info ?? { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } }), side: THREE.DoubleSide, transparent: true, toneMapped: false }))
    panelTitle.position.set(0, 2.55, .04)
    panel.add(panelTitle)
    panelLabel('quest feature panel', 2.20)
    panelLabel('billboards (0)  trees (0)  boulders (0)', 1.96)
    const keys = [
      ['billboard+', 'billboards +', 1.72, { width: .76, x: -.42 }], ['billboard-', 'billboards -', 1.72, { width: .76, x: .42 }],
      ['tree+', 'trees +', 1.48, { width: .76, x: -.42 }], ['tree-', 'trees -', 1.48, { width: .76, x: .42 }],
      ['boulder+', 'boulders +', 1.24, { width: .76, x: -.42 }], ['boulder-', 'boulders -', 1.24, { width: .76, x: .42 }],
      ['treeMode', 'tree render: individual', 1.00],
      ['billboardMode', 'billboard render: individual', .76],
      ['terrain', 'terrain: flat card', .52],
      ['scale+', 'scale x2', .28, { width: .76, x: -.42 }], ['scale-', 'scale /2', .28, { width: .76, x: .42 }],
      ['verts+', 'verts x2', .04, { width: .76, x: -.42 }], ['verts-', 'verts /2', .04, { width: .76, x: .42 }],
      ['lighting', 'terrain lighting: off', -.20],
      ['masked', 'masked alpha: on', -.44],
      ['inward', 'inward faces: off', -.68],
      ['lakes', 'lake pools: off', -.92],
      ['reflection', 'cubemap reflection: off', -1.16],
      ['sky', 'sky + day/night: off', -1.40, { width: 1.4, x: -.2 }],
      ['skip5h', '+5h', -1.40, { width: .5, x: .86 }],
    ]
    for (const [key, text, y, opts] of keys) panelButton(key, text, y, opts)
    const flyLabel = panelLabel('locomotion: walk (A/X to fly)', -1.72)

    // --- terrain / scatter --------------------------------------------------
    const groundTexture = grassTexture(sceneEl.renderer)
    groundTexture.repeat.set(128 / 3, 128 / 3)
    // The procedural terrain's own UVs are world-locked (metres / 3, see
    // makeTerrain below), so it needs its own clone with no repeat multiplier
    // baked on top -- sharing groundTexture's repeat would double-tile it.
    const terrainGroundTexture = groundTexture.clone()
    terrainGroundTexture.repeat.set(1, 1)
    terrainGroundTexture.needsUpdate = true

    function makeTerrain() {
      if (!state.terrain) {
        const flatMaterial = state.lit
          ? new THREE.MeshLambertMaterial({ map: groundTexture, side: side() })
          : new THREE.MeshBasicMaterial({ map: groundTexture, side: side() })
        const m = new THREE.Mesh(new THREE.PlaneGeometry(128, 128), flatMaterial)
        m.rotation.x = -Math.PI / 2
        return m
      }
      const terrainMaterial = state.lit
        ? new THREE.MeshLambertMaterial({ map: terrainGroundTexture, side: side() })
        : new THREE.MeshBasicMaterial({ map: terrainGroundTexture, side: side() })
      const n = state.vertices, size = state.terrainScale, positions = [], uvs = [], indices = []
      for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
          const px = (x / (n - 1) - .5) * size
          const pz = (z / (n - 1) - .5) * size
          positions.push(px, elevation(px, pz), pz)
          uvs.push(px / 3, pz / 3) // world-locked so a tile stays 3m regardless of terrainScale
        }
      }
      for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) { const a = z * n + x, b = a + 1, c = a + n, d = c + 1; indices.push(a, c, b, b, c, d) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      g.setIndex(indices)
      g.computeVertexNormals()
      return new THREE.Mesh(g, terrainMaterial)
    }
    const heightAt = (x, z) => (state.terrain ? elevation(x, z) : 0)

    // The arena props scatter over the flat plane's own fixed 128x128m
    // footprint, not state.terrainScale -- that slider resizes the
    // procedural terrain test case, not the play area.
    const ARENA_HALF = 62
    const PANEL_CLEARANCE = 4
    function scatterXZ(i, salt, footprintRadius = 0) {
      const clearance = PANEL_CLEARANCE + footprintRadius
      let x = (hash(i, salt) * 2 - 1) * ARENA_HALF
      let z = (hash(i, salt + 1) * 2 - 1) * ARENA_HALF
      const dx = x - panel.position.x, dz = z - panel.position.z
      const d = Math.hypot(dx, dz)
      if (d < clearance) {
        const a = d > 1e-4 ? Math.atan2(dz, dx) : hash(i, salt + 2) * Math.PI * 2
        x = panel.position.x + Math.cos(a) * clearance
        z = panel.position.z + Math.sin(a) * clearance
      }
      return [x, z]
    }

    // --- real props: texture array, tree bank, rock bank --------------------
    // propAtlas/propMaterial/treeGeometries/treeBillboardGeometry/rockMaterial
    // are null until the background loadAssets() task finishes (see bottom of
    // init) -- the world renders and is walkable long before that; every prop
    // kind depending on them is skipped until assetsReady, then rebuild()
    // runs again so anything already dialed up on the panel appears.
    let assetsReady = false
    let assetError = null
    let assetStage = 'not started'
    let propAtlas = null
    let treeBillboardGeometry = null
    let treeGeometries = null
    let propMaterial = null
    let rockMaterial = null

    function clearContent() {
      while (content.children.length) {
        const o = content.children.pop()
        // treeBillboardGeometry is shared (unlike trees, billboard meshes/
        // instances reuse it directly rather than cloning per-instance) --
        // disposing it here would destroy it out from under every future
        // rebuild, since it's never rebuilt itself.
        o.traverse((n) => { if (n.isBatchedMesh) { n.dispose(); return } if (n.geometry && n.geometry !== treeBillboardGeometry) n.geometry.dispose() })
      }
    }

    function placeProps() {
      if (!assetsReady) return
      const makeBillboard = (i) => {
        const [x, z] = scatterXZ(i, 10)
        return { x, y: heightAt(x, z), z, rotY: hash(i, 12) * Math.PI * 2 }
      }
      if (state.billboardCount > 0) {
        const placements = []
        for (let i = 0; i < state.billboardCount; i++) placements.push(makeBillboard(i))
        placeBillboards(placements)
      }
      const treePlacements = []
      for (let i = 0; i < state.treeCount; i++) {
        const variant = Math.floor(hash(i, 23) * treeGeometries.length) % treeGeometries.length
        const geo = treeGeometries[variant]
        const scale = Math.min(1, 2 / geo.userData.tree.height) // cap at 2m tall
        const [x, z] = scatterXZ(i, 20, (geo.userData.tree.crownWidth / 2) * scale)
        treePlacements.push({ variant, x, y: heightAt(x, z), z, scale, rotY: hash(i, 24) * Math.PI * 2 })
      }
      placeTrees(treePlacements)
      const makeBoulder = (i) => {
        const name = ROCK_NAMES[i % ROCK_NAMES.length]
        const geo = buildRock({ ...rockParams(name, 1978 + i), tier: 0 })
        const scale = Math.min(1, 2 / geo.userData.rock.measured.height) // cap at 2m tall
        const measured = geo.userData.rock.measured
        const [x, z] = scatterXZ(i, 30, (Math.max(measured.width, measured.depth) / 2) * scale)
        const m = new THREE.Mesh(geo, rockMaterial)
        m.material.side = side(); m.material.needsUpdate = true
        m.scale.setScalar(scale)
        m.position.set(x, heightAt(x, z), z)
        content.add(m)
      }
      for (let i = 0; i < state.boulderCount; i++) makeBoulder(i)
    }
    // Billboards share the real tree-bank's impostor geometry/atlas material,
    // same as trees -- 'individual' is one draw call per billboard;
    // 'instanced' collapses all of them into one THREE.InstancedMesh. There's
    // no 'batched' option here (unlike full trees) -- see the top-of-file
    // note: A-Frame 1.5.0's bundled three.js predates THREE.BatchedMesh.
    function placeBillboards(placements) {
      const mat = propMaterial.clone()
      mat.side = side(); mat.alphaTest = state.masked ? .5 : 0
      mat.onBeforeCompile = propMaterial.onBeforeCompile
      mat.customProgramCacheKey = propMaterial.customProgramCacheKey
      if (state.billboardMode === 'individual') {
        for (const p of placements) {
          const m = new THREE.Mesh(treeBillboardGeometry, mat)
          m.position.set(p.x, p.y, p.z)
          m.rotation.y = p.rotY
          content.add(m)
        }
        return
      }
      const im = new THREE.InstancedMesh(treeBillboardGeometry, mat, placements.length)
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const scaleVec = new THREE.Vector3(1, 1, 1)
      const pos = new THREE.Vector3()
      placements.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rotY)
        pos.set(p.x, p.y, p.z)
        m4.compose(pos, q, scaleVec)
        im.setMatrixAt(i, m4)
      })
      im.instanceMatrix.needsUpdate = true
      im.userData.triangleCount = ((treeBillboardGeometry.index ? treeBillboardGeometry.index.count : treeBillboardGeometry.attributes.position.count) / 3) * placements.length
      content.add(im)
    }
    // The 131k-triangle full-tree case is expensive not because of raw
    // triangle count but because 'individual' issues one draw call (with its
    // own JS-side state churn) per tree -- 'instanced' trades that for one
    // THREE.InstancedMesh per distinct tree variant (hardware instancing,
    // GPU-side matrix array).
    function placeTrees(placements) {
      if (!placements.length) return
      if (state.treeMode === 'individual') {
        for (const p of placements) {
          const geo = treeGeometries[p.variant]
          const m = new THREE.Mesh(geo.clone(), propMaterial)
          m.material.side = side(); m.material.alphaTest = state.masked ? .5 : 0; m.material.needsUpdate = true
          m.scale.setScalar(p.scale)
          m.position.set(p.x, p.y, p.z)
          m.rotation.y = p.rotY
          content.add(m)
        }
        return
      }
      const q = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const scaleVec = new THREE.Vector3()
      const pos = new THREE.Vector3()
      const m4 = new THREE.Matrix4()
      const byVariant = new Map()
      for (const p of placements) { if (!byVariant.has(p.variant)) byVariant.set(p.variant, []); byVariant.get(p.variant).push(p) }
      for (const [variant, group] of byVariant) {
        const geo = treeGeometries[variant].clone()
        const im = new THREE.InstancedMesh(geo, propMaterial, group.length)
        im.material.side = side(); im.material.alphaTest = state.masked ? .5 : 0; im.material.needsUpdate = true
        group.forEach((p, idx) => {
          q.setFromAxisAngle(up, p.rotY)
          scaleVec.setScalar(p.scale)
          pos.set(p.x, p.y, p.z)
          im.setMatrixAt(idx, m4.compose(pos, q, scaleVec))
        })
        im.instanceMatrix.needsUpdate = true
        im.userData.triangleCount = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) * group.length
        content.add(im)
      }
    }
    function makeLakes() {
      if (!state.lakes) return
      const lakeGroup = new THREE.Group()
      for (let i = 0; i < 3; i++) {
        const g = new THREE.CircleGeometry((3 + i) * 2, 20)
        const m = new THREE.MeshStandardMaterial({ color: 0x397a9b, roughness: .18, metalness: .05, side: side() })
        const lake = new THREE.Mesh(g, m)
        const a = hash(i, 8) * Math.PI * 2, r = 10 + i * 8
        const x = Math.cos(a) * r, z = Math.sin(a) * r - 8
        lake.rotation.x = -Math.PI / 2
        lake.position.set(x, heightAt(x, z) + .08, z)
        lakeGroup.add(lake)
      }
      lakeGroup.userData.lakes = true
      content.add(lakeGroup)
    }
    let cubeTarget = null
    let cubeCamera = null
    function updateReflection() {
      if (!state.reflection) { cubeTarget?.dispose(); cubeTarget = null; cubeCamera = null; return }
      if (!cubeTarget) {
        cubeTarget = new THREE.WebGLCubeRenderTarget(128)
        cubeCamera = new THREE.CubeCamera(.1, 500, cubeTarget)
        scene3D.add(cubeCamera)
      }
      content.traverse((o) => { if (o.userData.lakes) o.children.forEach((lake) => { lake.material.envMap = cubeTarget.texture; lake.material.needsUpdate = true }) })
    }

    function rebuild() {
      clearContent()
      const terrain = makeTerrain()
      terrain.userData.terrain = true
      content.add(terrain)
      placeProps()
      makeLakes()
      // The panel sits at a fixed world XZ, but enabling procedural terrain
      // can put the real ground metres away from y=0 there -- pin its height
      // to the ground beneath it rather than a flat 1.6m.
      panel.position.y = heightAt(panel.position.x, panel.position.z) + 1.6
      updatePanel()
      updateLabels()
      updateReflection()
    }

    // A BatchedMesh's own .geometry is sized to its RESERVED capacity, and an
    // InstancedMesh's one geometry draws N times -- both carry a precomputed
    // userData.triangleCount instead of being counted from their buffers.
    function triangles() { let n = 0; content.traverse((o) => { if (o.userData.triangleCount !== undefined) n += o.userData.triangleCount; else if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 }); return n }
    function updatePanel() {
      for (const m of panelMeshes) {
        const k = m.userData.key
        let t = null
        if (k === 'billboard+' || k === 'billboard-' || k === 'tree+' || k === 'tree-' || k === 'boulder+' || k === 'boulder-') continue // static "+ / -" labels
        if (k === 'treeMode') t = `tree render: ${state.treeMode}`
        if (k === 'billboardMode') t = `billboard render: ${state.billboardMode}`
        if (k === 'terrain') t = `terrain: ${state.terrain ? 'perlin' : 'flat card'}`
        if (k === 'scale+') t = `scale ${state.terrainScale}m  x2`
        if (k === 'verts+') t = `verts ${state.vertices}  x2`
        if (k === 'scale-' || k === 'verts-') continue
        if (k === 'lighting') t = `terrain lighting: ${state.lit ? 'on' : 'off'}`
        if (k === 'masked') t = `masked alpha: ${state.masked ? 'on' : 'off'}`
        if (k === 'inward') t = `inward faces: ${state.inward ? 'on' : 'off'}`
        if (k === 'lakes') t = `lake pools: ${state.lakes ? 'on' : 'off'}`
        if (k === 'reflection') t = `cubemap reflection: ${state.reflection ? 'on' : 'off'}`
        if (k === 'sky') t = `sky + day/night: ${state.sky ? `on (${clock.clockText})` : 'off'}`
        if (t !== null) setPanelMap(m, t)
      }
    }
    function updateLabels() {
      setPanelMap(panelLabels[1], `billboards (${state.billboardCount})  trees (${state.treeCount})  boulders (${state.boulderCount})`, null, '#8fd48f')
      const assetLine = assetError ? `assets: FAILED (${assetStage})` : assetsReady ? '' : ` -- loading assets: ${assetStage}`
      setPanelMap(panelLabels[0], `quest feature panel${assetLine}`, null, assetError ? '#ff9a7a' : '#8fd48f')
    }

    // --- key handling --------------------------------------------------------
    const CONTENT_KEYS = new Set([
      'billboard+', 'billboard-', 'tree+', 'tree-', 'boulder+', 'boulder-',
      'treeMode', 'billboardMode', 'terrain', 'scale+', 'scale-', 'verts+', 'verts-',
      'lighting', 'masked', 'inward', 'lakes', 'reflection',
    ])
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
      if (key === 'scale+') state.terrainScale = state.terrainScale * 2
      if (key === 'scale-') state.terrainScale = Math.max(8, state.terrainScale / 2)
      if (key === 'verts+') state.vertices = state.vertices * 2
      if (key === 'verts-') state.vertices = Math.max(16, Math.floor(state.vertices / 2))
      if (key === 'lighting') state.lit = !state.lit
      if (key === 'masked') state.masked = !state.masked
      if (key === 'inward') state.inward = !state.inward
      if (key === 'lakes') state.lakes = !state.lakes
      if (key === 'reflection') state.reflection = !state.reflection
      if (key === 'sky') { state.sky = !state.sky; if (!state.sky) resetSkyVisuals() }
      if (key === 'skip5h') clock.skip(5)

      if (CONTENT_KEYS.has(key)) rebuild()
      else { updatePanel(); updateLabels() }
    }

    // --- input: mouse (flatscreen) + laser-controls (VR) --------------------
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

    // Each frame we raycast every laser-controls entity against the panel
    // (updateControllerHover, called from tick()) and park the result on
    // entry.hit; a small red dot marks the hit point, and 'triggerdown' just
    // activates whatever that same hover already found. Reusing
    // el.components.raycaster.raycaster (laser-controls' own THREE.Raycaster,
    // configured per controller profile once it connects) guarantees this
    // lines up with the laser the player actually sees.
    const dotGeometry = new THREE.SphereGeometry(.012, 12, 8)
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false, depthTest: false })
    const controllerHits = new Map()
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

    // --- locomotion: movement-controls + blink-controls on #rig (declared in
    // quest.html) handle actual movement; A/X toggles walk vs. fly ----------
    const rigEl = sceneEl.querySelector('#rig')
    let flying = false
    function setFlying(next) {
      flying = next
      rigEl.setAttribute('movement-controls', 'fly', flying)
      setPanelMap(flyLabel, `locomotion: ${flying ? 'fly' : 'walk'} (A/X to toggle)`, null, '#8fd48f')
    }
    sceneEl.querySelectorAll('[laser-controls]').forEach((el) => {
      el.addEventListener('abuttondown', () => setFlying(!flying))
      el.addEventListener('xbuttondown', () => setFlying(!flying))
    })

    // --- stats ---------------------------------------------------------------
    let fps = 0, fpsFrames = 0, fpsAt = performance.now()
    let lastFrame = performance.now()

    this.tick = (_t, _dtMs) => {
      updateControllerHover()
      const now = performance.now()
      const dt = Math.min(.1, Math.max(0, (now - lastFrame) / 1000))
      lastFrame = now
      if (state.sky) applySky(dt)

      fpsFrames++
      if (now - fpsAt >= 500) {
        fps = Math.round((fpsFrames * 1000) / (now - fpsAt)); fpsFrames = 0; fpsAt = now
        if (sceneEl.renderer) {
          const info = sceneEl.renderer.info
          const tris = triangles()
          if (statsEl) {
            const assetLine = assetError ? `assets: FAILED at "${assetStage}": ${assetError.message ?? assetError}` : assetsReady ? 'assets: ready' : `assets: loading (${assetStage}) ...`
            statsEl.innerHTML = `triangles: ${tris.toLocaleString()}\nFPS: ${fps}\ndraw calls: ${info.render.calls}\ngeometries: ${info.memory.geometries}  textures: ${info.memory.textures}\n${assetLine}\n${sceneEl.is('vr-mode') ? 'XR: presenting' : 'XR: inline'}`
          }
          panelTitle.material.map?.dispose()
          panelTitle.material.map = statsTexture(tris, fps, info)
          panelTitle.material.needsUpdate = true
        }
      }
      if (cubeCamera && Math.floor(now / 500) % 3 === 0) {
        content.traverse((o) => { if (o.userData.lakes) o.children.forEach((lake) => { lake.visible = false }) })
        cubeCamera.update(sceneEl.renderer, scene3D)
        content.traverse((o) => { if (o.userData.lakes) o.children.forEach((lake) => { lake.visible = true }) })
      }
    }

    // --- boot: synchronous flat world first, real assets stream in after ----
    // The Above Par pattern -- render immediately with whatever's cheap and
    // synchronous (flat terrain, no props), then stream the expensive stuff
    // (texture array, tree-bank, impostor baking, material compile) in after
    // first paint, off the boot-blocking path. propAtlas is built here
    // (synchronous, just typed-array setup); loadImageLayers/bakeTreeImpostors
    // are the real async/GPU work.
    assetStage = 'building texture array'
    propAtlas = buildTextureArray()

    function loadAssets() {
      assetStage = 'loading atlas images'
      updateLabels()
      return loadImageLayers(propAtlas)
        .then(() => {
          assetStage = 'building tree bank'
          const treeBank = buildTreeBank({ seed: 20260828, billboard: true })
          assetStage = 'baking tree impostors (render-to-texture)'
          bakeTreeImpostors(sceneEl.renderer, propAtlas, { seed: 20260828 })
          treeBillboardGeometry = treeBank.tiers[3].geometries[0]
          treeGeometries = treeBank.tiers[0].geometries // LOD0: the real tree, ~500-800 tris incl. leaf cards
          assetStage = 'compiling prop material'
          propMaterial = createPropMaterial(propAtlas)
          const propPatch = propMaterial.onBeforeCompile
          propMaterial.onBeforeCompile = (shader, object) => { propPatch(shader, object); wrapLambert(shader) }
          propMaterial.customProgramCacheKey = () => 'quest-prop-array-wrap-v1'
          rockMaterial = propMaterial.clone()
          // Material.clone()/copy() does NOT carry over onBeforeCompile or
          // customProgramCacheKey (plain instance properties, not part of
          // Material's copy list) -- without this, rockMaterial silently
          // falls back to the no-op prototype onBeforeCompile and every rock
          // renders as flat white material.color.
          rockMaterial.onBeforeCompile = propMaterial.onBeforeCompile
          rockMaterial.customProgramCacheKey = () => 'quest-rock-array-wrap-v1'
          assetsReady = true
          rebuild() // re-run now that treeGeometries/propMaterial/rockMaterial exist
        })
        .catch((err) => { assetError = err; console.error('quest background asset load failed', err); updateLabels() })
    }

    // First paint: flat terrain, zero props -- entirely synchronous, lands
    // well under a second. Real props/materials arrive via loadAssets() and
    // trigger a second rebuild() once ready.
    rebuild()
    loadAssets()
  },
})
