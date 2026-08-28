import THREE from './three-instance.js'

const BLUE = 0x18bfff
const DEADZONE = 0.18

export class XRControls {
  constructor(renderer, scene, camera, player, terrainHeight, onNewGame) {
    this.renderer = renderer; this.camera = camera; this.player = player
    this.terrainHeight = terrainHeight; this.onNewGame = onNewGame; this.menuOpen = false
    this.controllers = [renderer.xr.getController(0), renderer.xr.getController(1)]
    this.controllers.forEach((c) => scene.add(c))
    this.teleport = new THREE.Group(); this.teleport.visible = false; scene.add(this.teleport)
    this.arcGlow = this._line(new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: .28 }))
    this.arcCore = this._line(new THREE.LineBasicMaterial({ color: 0x9eeaff, transparent: true, opacity: .95 }))
    this.teleport.add(this.arcGlow, this.arcCore)
    this.ring = new THREE.Mesh(new THREE.RingGeometry(.22, .27, 48), new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: .85, side: THREE.DoubleSide }))
    this.ring.rotation.x = -Math.PI / 2; this.teleport.add(this.ring)
    this.lasers = this.controllers.map(() => this._line(new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: .9 })))
    this.lasers.forEach((laser) => { laser.visible = false; scene.add(laser) })
    this.dots = this.controllers.map(() => new THREE.Mesh(new THREE.SphereGeometry(.025, 12, 8), new THREE.MeshBasicMaterial({ color: 0xa8efff })))
    this.dots.forEach((dot) => { dot.visible = false; scene.add(dot) })
    this.lastTarget = null; this.raycaster = new THREE.Raycaster()
    this.origin = new THREE.Vector3(); this.direction = new THREE.Vector3(); this.quaternion = new THREE.Quaternion(); this.point = new THREE.Vector3()
    this._makeMenu()
  }

  _line(material) {
    const mesh = new THREE.Line(new THREE.BufferGeometry(), material); mesh.frustumCulled = false; return mesh
  }

  _makeMenu() {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 360
    const c = canvas.getContext('2d'); c.fillStyle = 'rgba(7,17,34,.97)'; c.fillRect(0, 0, 900, 360)
    c.strokeStyle = '#2b8dcc'; c.lineWidth = 5; c.strokeRect(3, 3, 894, 354)
    c.fillStyle = '#bcecff'; c.font = 'bold 44px monospace'; c.fillText('AURORA', 42, 68)
    c.font = '26px monospace'; c.fillStyle = '#7897b9'; c.fillText('MAIN MENU', 45, 105)
    c.fillStyle = '#123a62'; c.fillRect(42, 145, 360, 110); c.strokeStyle = '#42caff'; c.strokeRect(42, 145, 360, 110)
    c.fillStyle = '#dff7ff'; c.font = 'bold 30px monospace'; c.fillText('NEW GAME', 112, 212)
    this.button = { minX: 42 / 900, maxX: 402 / 900, minY: 145 / 360, maxY: 255 / 360 }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
    this.menu = new THREE.Mesh(new THREE.PlaneGeometry(.9, .36), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }))
    this.menu.position.set(0, -.08, -1.15); this.menu.renderOrder = 1001; this.menu.visible = false; this.camera.add(this.menu)
  }

  toggleMenu() {
    this.menuOpen = !this.menuOpen; this.menu.visible = this.menuOpen && this.renderer.xr.isPresenting
    this.teleport.visible = false; this.lastTarget = null
  }

  _pointer(controller) {
    controller.getWorldPosition(this.origin); controller.getWorldQuaternion(this.quaternion)
    this.direction.set(0, 0, -1).applyQuaternion(this.quaternion).normalize()
    return { origin: this.origin, direction: this.direction }
  }

  _controller(side) {
    return side?.source ? this.renderer.xr.getController(side.sourceIndex) : null
  }

  _showTeleport(controller) {
    if (!controller) return null
    const { origin, direction } = this._pointer(controller); const points = []; let hit = null
    for (let i = 0; i <= 28; i++) {
      const t = i / 28; const distance = .25 + t * 10
      this.point.copy(origin).addScaledVector(direction, distance); this.point.y += 4.2 * t * (1 - t)
      points.push(this.point.clone())
      if (!hit && i > 0 && this.point.y <= this.terrainHeight.heightAt(this.point.x, this.point.z) + .08) hit = { x: this.point.x, y: this.terrainHeight.heightAt(this.point.x, this.point.z), z: this.point.z }
    }
    if (!hit) { this.teleport.visible = false; this.lastTarget = null; return null }
    for (const mesh of [this.arcGlow, this.arcCore]) { mesh.geometry.dispose(); mesh.geometry = new THREE.BufferGeometry().setFromPoints(points) }
    this.ring.position.set(hit.x, hit.y + .025, hit.z); this.teleport.visible = true; this.lastTarget = hit; return hit
  }

  update(state, desktopTeleport = false) {
    if (this.menuOpen) {
      this.teleport.visible = false
      for (const hand of ['left', 'right']) {
        const side = state[hand]; if (!side.source) continue
        const i = side.sourceIndex; const controller = this._controller(side); if (!controller || !this.lasers[i]) continue
        const p = this._pointer(controller); const end = p.origin.clone().addScaledVector(p.direction, 5)
        this.lasers[i].geometry.dispose(); this.lasers[i].geometry = new THREE.BufferGeometry().setFromPoints([p.origin.clone(), end]); this.lasers[i].visible = true; this.dots[i].position.copy(end); this.dots[i].visible = true
      }
      for (const hand of ['left', 'right']) if (state[hand].buttons.TRIGGER?.justPressed) {
        const controller = this._controller(state[hand]); if (!controller) continue
        const p = this._pointer(controller); this.raycaster.set(p.origin, p.direction)
        const hit = this.raycaster.intersectObject(this.menu)[0]
        if (hit) { const x = hit.uv.x; const y = 1 - hit.uv.y; if (x >= this.button.minX && x <= this.button.maxX && y >= this.button.minY && y <= this.button.maxY) { this.onNewGame(); this.toggleMenu() } }
      }
      return
    }
    this.lasers.forEach((laser) => { laser.visible = false }); this.dots.forEach((dot) => { dot.visible = false })
    const active = !this.player.flying && (state.left.axes[1] < -DEADZONE || state.right.axes[1] < -DEADZONE)
    if (desktopTeleport) {
      const fake = { getWorldPosition: (o) => this.camera.getWorldPosition(o), getWorldQuaternion: (q) => this.camera.getWorldQuaternion(q) }
      if (active) this._showTeleport(fake)
      else if (this.lastTarget) { this.player.teleportTo(this.lastTarget.x, this.lastTarget.z); this.lastTarget = null; this.teleport.visible = false }
      return
    }
    let hand = state.left.axes[1] < -DEADZONE ? 'left' : null
    if (state.right.axes[1] < -DEADZONE && (!hand || state.right.axes[1] < state.left.axes[1])) hand = 'right'
    if (hand) this._showTeleport(this._controller(state[hand]))
    else if (this.lastTarget) { this.player.teleportTo(this.lastTarget.x, this.lastTarget.z); this.lastTarget = null; this.teleport.visible = false }
  }

  flyDirection(state) {
    const hand = state.right.axes[1] < state.left.axes[1] ? 'right' : 'left'; const source = state[hand].source
    if (!source) return null
    return this._pointer(this._controller(state[hand])).direction.clone()
  }
}
