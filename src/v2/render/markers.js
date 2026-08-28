import THREE from '../../three-instance.js'

/**
 * The editor's visible handles: every snow line point, every spline control point, every lake centre.
 *
 * ONE InstancedMesh PER KIND, NOT ONE MESH PER POINT. A world that has been authored for an afternoon holds hundreds of snow points and hundreds of spline points, and this is a debug overlay -- it is allowed to cost a rounding error and nothing more. Three instanced draws for the whole overlay is that; three hundred Object3Ds, each with its own matrix update and its own frustum test every frame, is not, and the cost would land on the editor exactly when the world is big enough to be worth editing.
 *
 * HANDLES SCALE WITH DISTANCE, which is the difference between an overlay and a toy. A fixed-size handle is a 40 cm blob you cannot hit at 2 km and a wall you cannot see past at 2 m. See HANDLE_TAN for the three regimes: constant angular size up close, constant WORLD size in the middle distance, and a 3 px floor beyond that.
 *
 * They also draw through the terrain (depthTest false, high renderOrder) because a handle you cannot see is a handle you cannot select, and half of what gets authored -- a river bed, a lake floor -- is by construction below the ground it is being authored into.
 */

// Tangent of the handle's angular HALF-size, so world radius = distance * this. 0.6 degrees: on a 1080-row display at a 60 degree vertical FOV that is about 11 px of radius, a 22 px target, which is comfortably clickable with a mouse and still small enough that a dense spline does not become a wall of beads.
const HANDLE_TAN = Math.tan((0.6 * Math.PI) / 180)
const HANDLE_PX = 11 // what that angle is worth on that display, so the floor below can be written in pixels

// CONSTANT ANGULAR SIZE ONLY OUT TO HERE. Past this distance the handle keeps the world size it had at this distance, so it recedes exactly like the ground it is sitting on. Holding 22 px all the way out was the first version and it is wrong for the same reason a fixed world size is wrong at the other end: a river drawn across the valley became a chain of beads the size of houses, hiding the terrain the author was trying to look at, and a snow field of a hundred points was an opaque wall. 120 m is roughly "the near half of what you can see while editing" -- inside it nothing has changed, and a handle is still 22 px at arm's length.
const HANDLE_FULL_M = 120

// ...but never smaller than 3 px WIDE, which is 1.5 px of radius. A handle that recedes to nothing is a point you cannot find again, and the far field is exactly where "where did I put that river" matters. 3 px is the smallest thing that still reads as a deliberate mark rather than as a stuck pixel. The floor bites at HANDLE_FULL_M * HANDLE_PX / HANDLE_FLOOR_PX = 880 m; past that every handle in the world is the same 3 px.
//
// It stays SELECTABLE at 3 px because picking does not go through this size at all: editor.js hit-tests within HANDLE_PICK_PX (10 px) of the handle's centre in screen space, so the click target is unchanged by anything here.
const HANDLE_FLOOR_PX = 1.5
const HANDLE_FLOOR_TAN = (HANDLE_TAN * HANDLE_FLOOR_PX) / HANDLE_PX

// Floor on the radius in metres, for a handle nearly touching the near plane. Without it the scale goes to zero at the camera and the handle you are leaning over disappears.
const HANDLE_MIN = 0.15

// What selection does to a handle. Scale as well as colour: colour alone is invisible to anyone selecting the handle that is currently under the cursor, because the cursor is on top of it.
const HIGHLIGHT_SCALE = 1.7
const HIGHLIGHT_COLOR = new THREE.Color(1.0, 0.95, 0.35)

// The snow line ramp. Cold blue below the base elevation, warm ochre above, bone white at no deviation -- so a field of a hundred points reads as a heat map of where the line has been pulled up and down without a single click.
//
// The ramp saturates at one `snow.band` of deviation (47 m as shipped) rather than at a number written here. The band is the width of the soft transition from bare ground to full cover, so a point that moves the line by a whole band has moved it by the entire visible depth of the effect -- which is the natural full-scale for "how much has this point done".
const SNOW_COLD = new THREE.Color(0.25, 0.55, 1.0)
const SNOW_WARM = new THREE.Color(1.0, 0.42, 0.12)
const SNOW_FLAT = new THREE.Color(0.85, 0.87, 0.9)

const RIVER_COLOR = new THREE.Color(0.3, 0.62, 0.95)
const ROAD_COLOR = new THREE.Color(0.85, 0.66, 0.35)
const LAKE_COLOR = new THREE.Color(0.35, 0.85, 0.95)

// Overlay draw order. Anything above the transparent pass three uses by default; the whole overlay is depth-test-free so the only ordering that matters is that it comes last.
const OVERLAY_ORDER = 999

const tmpMat = new THREE.Matrix4()
const tmpCam = new THREE.Vector3()
const tmpProj = new THREE.Vector3()
const tmpColor = new THREE.Color()

export class Markers {
  constructor({ scene, layers }) {
    if (!scene || !scene.isScene) throw new Error('Markers needs the Scene')
    if (!layers || !layers.snow || !layers.paths || !layers.lakes) throw new Error('Markers needs Layers, for the snow field and both sets')

    this.scene = scene
    this.layers = layers

    this.group = new THREE.Group()
    this.group.name = 'v2-markers'
    scene.add(this.group)

    this.material = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      // The flat rings are seen from underneath as often as from above -- a lake centre is at the water level and the camera is often below it, standing on the bed while the basin is being dug.
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.material.name = 'v2-marker'

    this.ringMaterial = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
      opacity: 0.55,
      color: SNOW_FLAT,
    })
    this.ringMaterial.name = 'v2-marker-radius'

    // Unit geometries: every instance is a uniform scale of one of these, so the whole overlay is three geometries however many handles exist.
    this.kinds = {
      // Octahedron rather than a sphere: eight flat faces catch the light differently from every angle, so a snow point reads as a distinct object against terrain that is all soft gradients -- and it is 8 triangles.
      snow: this.makeKind(new THREE.OctahedronGeometry(1, 0)),
      // A low sphere, 96 triangles. Spline points sit in dense runs and a faceted one would read as noise.
      spline: this.makeKind(new THREE.SphereGeometry(1, 8, 6)),
      // A TORUS in XZ, pre-rotated at construction so the instance matrices stay translation-and-scale and never need a rotation composed per frame.
      //
      // It was a flat RingGeometry, and a flat ring is the one handle shape that cannot be clicked: a lake's marker sits AT the water plane, which is where the camera usually is when a lake is being edited, so the ring is seen edge-on and presents a zero-area target to both the eye and the raycaster. A lake was the only object in the editor that could not be selected, and this is why. The tube gives it thickness from every angle for 168 triangles a lake, which is nothing beside not being able to select one.
      lake: this.makeKind(new THREE.TorusGeometry(0.82, 0.17, 6, 14).rotateX(-Math.PI / 2)),
    }

    // The selected snow point's RADIUS, drawn at its true size. This is the only way to author overlapping influence deliberately -- the Shepard kernel (§18) is compactly supported, so two points either reach each other or they do not, and the difference is invisible until the radii are drawn. One mesh, not an instanced one: exactly one point is selected at a time.
    this.radiusRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2), this.ringMaterial)
    this.radiusRing.name = 'v2-marker-radius-ring'
    this.radiusRing.renderOrder = OVERLAY_ORDER
    this.radiusRing.visible = false
    this.radiusRing.frustumCulled = false
    this.group.add(this.radiusRing)

    this.highlight = null
    this.epoch = -1

    // What the layer panel's eye toggles actually do. Everything is visible until a host says otherwise; see setVisibility.
    this.isVisible = () => true
  }

  /**
   * Filter what sync() draws: `fn(kind, id, index)` in the EDITOR's vocabulary -- kind snow/lake/river/road, id null for a snow point, index null for a whole object -- not in this file's geometry-kind vocabulary. The editor owns the hidden set (hiding is a render decision and the document is the authored truth), and this is the one channel by which it reaches the overlay.
   *
   * Filtering in sync() rather than at draw time is what makes a hidden object genuinely gone: it is not in `records`, so it is not in the instance buffers, and both hitTest paths therefore cannot select it. A hidden handle you can still click is worse than one you cannot hide.
   */
  setVisibility(fn) {
    if (typeof fn !== 'function') throw new Error('Markers.setVisibility needs a (kind, id, index) => boolean')
    this.isVisible = fn
    this.sync()
  }

  makeKind(geometry) {
    return { geometry, mesh: null, capacity: 0, count: 0, positions: [], colors: [], records: [] }
  }

  /**
   * Rebuild every handle's position, colour and identity from the document.
   *
   * Cheap enough to call on every epoch bump: it walks the authored arrays once and writes into buffers that already exist, and only reallocates when a kind outgrows its InstancedMesh. It does NOT write instance matrices -- those depend on where the camera is, so they belong to update().
   *
   * A snow point is drawn at the elevation it authors, `snow.base + delta`, because a point in a 2D field has no y of its own and putting it on the ground would hide exactly the number it exists to set. Dragging one vertically therefore edits its delta directly, which is the reading the move gizmo wants anyway.
   *
   * HANDLE IDENTITY IS THE RAW ARRAY INDEX, HOLES INCLUDED, and both layers now agree on that: SnowField.removePoint and PathSet.removePoint both TOMBSTONE the slot (`points[i] = null`, `pts[i] = null`) rather than splicing, precisely so a held selection does not silently repoint to its neighbour. So every loop here skips nulls for drawing while `i` keeps counting past them, and `records.push({ index: i })` publishes the index the editor addresses the point by. Compacting the counter instead would shift every handle above a hole by one, which is the exact bug the tombstones exist to prevent.
   *
   * The corollary, and the reason `pts.length` and `points.length` still appear as loop bounds: those lengths count tombstones, so they are the right thing to ITERATE and the wrong thing to report as a count. PathSet.pointsOf / handlesOf are the live-order accessors for anyone who wants the latter.
   */
  sync() {
    const snow = this.layers.snow
    if (!Array.isArray(snow.points)) throw new Error('Markers.sync: layers.snow.points is missing; SnowField always carries it, empty at worst')
    if (!Number.isFinite(snow.base) || !Number.isFinite(snow.band)) throw new Error(`Markers.sync: layers.snow needs finite base and band, got ${snow.base} / ${snow.band}`)

    for (const kind of Object.values(this.kinds)) {
      kind.positions.length = 0
      kind.colors.length = 0
      kind.records.length = 0
    }

    const s = this.kinds.snow
    for (let i = 0; i < snow.points.length; i++) {
      const p = snow.points[i]
      if (p === null) continue
      if (!this.isVisible('snow', null, i)) continue
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.delta) || !(p.radius > 0)) throw new Error(`Markers.sync: snow point ${i} is ${JSON.stringify(p)}, expected finite x, z, delta and radius > 0`)
      s.positions.push(p.x, snow.base + p.delta, p.z)
      const t = Math.max(-1, Math.min(1, p.delta / snow.band))
      tmpColor.copy(SNOW_FLAT).lerp(t < 0 ? SNOW_COLD : SNOW_WARM, Math.abs(t))
      s.colors.push(tmpColor.r, tmpColor.g, tmpColor.b)
      s.records.push({ kind: 'snow', id: 'snow', index: i })
    }

    const sp = this.kinds.spline
    // The control points, NOT the flattened samples: these are the things a mouse drags, and there are a dozen of them per path where there are thousands of samples.
    for (const path of this.layers.paths.paths.values()) {
      if (path.kind !== 'river' && path.kind !== 'road') throw new Error(`Markers.sync: path ${path.id} has kind ${path.kind}, expected river or road`)
      if (!this.isVisible(path.kind, path.id, null)) continue
      const c = path.kind === 'river' ? RIVER_COLOR : ROAD_COLOR
      for (let i = 0; i < path.pts.length; i++) {
        const p = path.pts[i]
        if (p === null) continue
        const [x, y, z] = p
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error(`Markers.sync: ${path.id} point ${i} is [${p}], expected finite [x, y, z, width]`)
        sp.positions.push(x, y, z)
        sp.colors.push(c.r, c.g, c.b)
        sp.records.push({ kind: 'spline', id: path.id, index: i })
      }
    }

    const lk = this.kinds.lake
    for (const lake of this.layers.lakes.lakes.values()) {
      if (!this.isVisible('lake', lake.id, null)) continue
      lk.positions.push(lake.x, lake.y, lake.z)
      lk.colors.push(LAKE_COLOR.r, LAKE_COLOR.g, LAKE_COLOR.b)
      lk.records.push({ kind: 'lake', id: lake.id, index: 0 })
    }

    for (const [name, kind] of Object.entries(this.kinds)) this.resize(name, kind)
    this.writeColors()
    this.epoch = this.layers.epoch
  }

  /** Grow a kind's InstancedMesh to fit, in powers of two so an editing session reallocates a handful of times rather than once per placed point. */
  resize(name, kind) {
    kind.count = kind.records.length
    if (kind.count > kind.capacity) {
      let cap = Math.max(64, kind.capacity)
      while (cap < kind.count) cap *= 2
      if (kind.mesh) {
        this.group.remove(kind.mesh)
        // Disposes the instance matrix and colour attributes only; the geometry and material are ours and outlive every reallocation.
        kind.mesh.dispose()
      }
      const mesh = new THREE.InstancedMesh(kind.geometry, this.material, cap)
      mesh.name = `v2-markers-${name}`
      mesh.renderOrder = OVERLAY_ORDER
      // The instances are scattered over the whole world and their bounds change every frame with the camera; a bounding sphere computed for that is the world, so culling it is a test that can only ever answer yes.
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.userData.kind = name
      kind.mesh = mesh
      kind.capacity = cap
      this.group.add(mesh)
    }
    if (kind.mesh) kind.mesh.count = kind.count
  }

  writeColors() {
    for (const kind of Object.values(this.kinds)) {
      if (!kind.mesh) continue
      for (let i = 0; i < kind.count; i++) {
        const r = kind.records[i]
        const on = this.highlight !== null && this.highlight.kind === r.kind && this.highlight.id === r.id && this.highlight.index === r.index
        if (on) tmpColor.copy(HIGHLIGHT_COLOR)
        else tmpColor.setRGB(kind.colors[i * 3], kind.colors[i * 3 + 1], kind.colors[i * 3 + 2])
        kind.mesh.setColorAt(i, tmpColor)
      }
      if (kind.mesh.instanceColor) kind.mesh.instanceColor.needsUpdate = true
    }
  }

  /**
   * Select a handle, or clear the selection with setHighlight(null).
   *
   * `index` identifies a point within its owner: the snow point's index in layers.snow.points, the control point's index in path.pts, 0 for a lake. It is the same triple hitTest returns, so the editor can hand back exactly what it was given.
   */
  setHighlight(kind, id, index) {
    if (kind !== null && !this.kinds[kind]) throw new Error(`Markers.setHighlight: no handle kind ${kind}`)
    this.highlight = kind === null ? null : { kind, id, index }
    this.writeColors()

    // The radius ring follows the selection, and only a snow point has a radius.
    this.radiusRing.visible = false
    if (this.highlight !== null && kind === 'snow') {
      const p = this.layers.snow.points[index]
      if (!p) throw new Error(`Markers.setHighlight: snow point ${index} does not exist (removed points leave a null hole at their index)`)
      this.radiusRing.position.set(p.x, this.layers.snow.base + p.delta, p.z)
      this.radiusRing.scale.setScalar(p.radius)
      this.radiusRing.visible = true
    }
  }

  /**
   * Rescale every instance for this frame's camera. Call it once a frame, after the camera has moved.
   *
   * This is a full rewrite of every instance matrix rather than an incremental one, and it is the right trade: a few hundred translate-and-scale composes is under a microsecond, while tracking which handles have crossed a distance threshold since last frame is state that can go stale and produce one handle at the wrong size, which is exactly the kind of bug an editor overlay must not have.
   */
  update(camera) {
    if (!camera || !camera.isCamera) throw new Error('Markers.update needs the camera; the handles are sized in angular units')
    camera.getWorldPosition(tmpCam)

    for (const kind of Object.values(this.kinds)) {
      if (!kind.mesh || kind.count === 0) continue
      for (let i = 0; i < kind.count; i++) {
        const x = kind.positions[i * 3]
        const y = kind.positions[i * 3 + 1]
        const z = kind.positions[i * 3 + 2]
        const dist = Math.hypot(x - tmpCam.x, y - tmpCam.y, z - tmpCam.z)
        // Angular up close, fixed-world past HANDLE_FULL_M, and never under the 3 px floor.
        let s = Math.max(HANDLE_MIN, dist * HANDLE_FLOOR_TAN, Math.min(dist, HANDLE_FULL_M) * HANDLE_TAN)
        const r = kind.records[i]
        if (this.highlight !== null && this.highlight.kind === r.kind && this.highlight.id === r.id && this.highlight.index === r.index) s *= HIGHLIGHT_SCALE
        tmpMat.makeScale(s, s, s)
        tmpMat.setPosition(x, y, z)
        kind.mesh.setMatrixAt(i, tmpMat)
      }
      kind.mesh.instanceMatrix.needsUpdate = true
    }
  }

  /**
   * What is under the ray, or null.
   *
   * three's raycaster reports `instanceId` on an InstancedMesh hit and applies each instance's matrix while doing it, so the distance-scaled handles are picked at the size they are drawn -- which is the whole reason the scaling is in the matrix and not in the shader.
   *
   * The terrain is deliberately not in this list. Handles draw through the ground, so they must be selectable through it too; a caller that wants "the nearest thing including terrain" compares this hit's distance against its own terrain hit.
   */
  hitTest(raycaster) {
    if (!raycaster || !raycaster.ray) throw new Error('Markers.hitTest needs a Raycaster')
    const targets = []
    for (const kind of Object.values(this.kinds)) {
      if (kind.mesh && kind.count > 0) targets.push(kind.mesh)
    }
    if (targets.length === 0) return null
    const hits = raycaster.intersectObjects(targets, false)
    if (hits.length === 0) return null
    const hit = hits[0]
    const kind = this.kinds[hit.object.userData.kind]
    const record = kind.records[hit.instanceId]
    if (!record) throw new Error(`Markers.hitTest: ${hit.object.name} reported instance ${hit.instanceId} with only ${kind.records.length} records; sync() and the InstancedMesh count have diverged`)
    return { kind: record.kind, id: record.id, index: record.index }
  }

  /**
   * The handle NEAREST THE CURSOR in screen space, within `tolX`/`tolY` NDC units, or null.
   *
   * The companion to hitTest, and the reason it exists: a raycast answers "did the pointer land ON a handle", which is the wrong question for a placement tool. Reaching for a snow point and missing it by six pixels does not do nothing -- it drops a NEW snow point in front of the one that was being reached for, and the world quietly gains an object nobody wanted. A miss has to be forgiving in the direction of selecting rather than creating.
   *
   * Nearest to the CURSOR, not to the camera, which is the opposite of what a raycast picks. Within a few pixels of two overlapping handles the one the pointer is actually closest to is the one being pointed at, whichever is in front.
   *
   * The projection is done by hand rather than through Vector3.project() so a handle BEHIND the camera can be rejected on its view-space z: project() divides by w, and for w < 0 that mirrors the point back into the frustum, which is how a river point behind your head gets picked when you click empty sky.
   */
  hitTestNear(camera, ndcX, ndcY, tolX, tolY) {
    if (!camera || !camera.isCamera) throw new Error('Markers.hitTestNear needs the camera')
    if (!(tolX > 0) || !(tolY > 0)) throw new Error(`Markers.hitTestNear: tolerances must be positive NDC spans, got ${tolX}, ${tolY}`)
    camera.updateMatrixWorld()

    let best = null
    let bestD2 = 1 // the tolerance ellipse, in normalised units -- anything past it is not a near miss
    for (const kind of Object.values(this.kinds)) {
      for (let i = 0; i < kind.count; i++) {
        tmpProj.set(kind.positions[i * 3], kind.positions[i * 3 + 1], kind.positions[i * 3 + 2])
        tmpProj.applyMatrix4(camera.matrixWorldInverse)
        if (tmpProj.z > -camera.near) continue // at or behind the eye
        tmpProj.applyMatrix4(camera.projectionMatrix)
        const dx = (tmpProj.x - ndcX) / tolX
        const dy = (tmpProj.y - ndcY) / tolY
        const d2 = dx * dx + dy * dy
        if (d2 > bestD2) continue
        bestD2 = d2
        best = kind.records[i]
      }
    }
    return best === null ? null : { kind: best.kind, id: best.id, index: best.index }
  }

  dispose() {
    for (const kind of Object.values(this.kinds)) {
      if (kind.mesh) {
        this.group.remove(kind.mesh)
        kind.mesh.dispose()
        kind.mesh = null
      }
      kind.geometry.dispose()
      kind.capacity = 0
      kind.count = 0
    }
    this.radiusRing.geometry.dispose()
    this.material.dispose()
    this.ringMaterial.dispose()
    this.group.clear()
    if (this.group.parent) this.group.parent.remove(this.group)
  }
}
