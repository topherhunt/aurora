import THREE from '../../three-instance.js'

// ---------------------------------------------------------------------------
// THE ARENA. A BatchedMesh-shaped facade over a plain THREE.InstancedMesh, so a
// scatter -- which touches the arena API from a couple of dozen places, four of
// them inside rim.js -- does not have to know which of the two it is holding.
//
// IT IS AN InstancedMesh BECAUSE A BatchedMesh IS NOT FASTER ON A QUEST 2, and
// that is a measurement rather than a preference: the same grass bed runs at
// single-digit fps batched and at fifty-plus instanced, on identical geometry.
//
// WHAT THE SHAPE COSTS, since a facade over a narrower thing always costs
// something:
//
//   ONE GEOMETRY, so there is no LOD ladder inside one arena. addGeometry
//   throws on a second, rather than quietly drawing the first for every tier and
//   leaving someone to wonder why the near props look flat. A scatter that wants
//   tiers holds ONE ARENA PER TIER and moves an instance between them, which is
//   a draw call per tier -- see render/ferns.js, which does exactly that.
//
//   NO PER-INSTANCE CULLING. There is none to have, so the /?quest panel's cull
//   row does nothing to a layer built on this. Hidden instances are not SKIPPED
//   either: an InstancedMesh draws a contiguous `count`, so hiding writes a ZERO
//   MATRIX and the prop collapses to a point. Its triangles are degenerate and
//   never rasterise, but its vertices still run. `count` is held at one past the
//   highest id ever shown rather than at the pool size, which keeps that waste to
//   the pool's high-water mark instead of all of it -- and it is the reason a
//   per-tier pool wants to be sized to what its own ring holds and no more.
//
//   The rim's dissolve is NOT on that list, and getting it back is what made this
//   shippable rather than a diagnostic. instanceColor is itemSize 3 in three
//   r180, so there is no alpha beside the tint to hide a timer in; the arena
//   carries `aPropFade` instead, one float per instance, and material.js reads it
//   through FADE_VERTEX's instancing branch. That is cheaper than the batched
//   path it replaces -- an attribute fetch where the batch did a vertex TEXTURE
//   fetch.
//
// A NOTE FOR ANYONE ADDING A SECOND ARENA TO ONE MATERIAL: three compiles a
// different program for an InstancedMesh whose `instanceColor` is null than for
// one whose is not, so two arenas sharing a material must AGREE. Give every one
// of them a `setColorAt` before its first render.
// ---------------------------------------------------------------------------
export class InstancedArena extends THREE.InstancedMesh {
  constructor(maxInstances, material) {
    // Geometry arrives through addGeometry, so a scatter's constructor makes the
    // same calls in the same order whichever of the two it is building.
    super(new THREE.BufferGeometry(), material, maxInstances)
    this._max = maxInstances
    this._next = 0
    this._geometrySet = false
    // instanceMatrix holds the ZEROED matrix while an instance is hidden, so it
    // cannot be the source of truth: rim.js hides a prop and later shows the
    // same one again, and getMatrixAt has to answer with the matrix it was
    // placed with. This shadow copy is that answer.
    this._shadow = new Float32Array(maxInstances * 16)
    this._visible = new Uint8Array(maxInstances)
    this._highWater = 0
    this.count = 0
    this.frustumCulled = false
    // Not real on an InstancedMesh, but main.js's applyBatchCulling reads both
    // off every batch it is handed and would otherwise record `undefined` as
    // this layer's default.
    this.perObjectFrustumCulled = false
    this.sortObjects = false
  }

  /**
   * Take this arena's one geometry. CLONED, because a scatter disposes every
   * bank geometry as soon as it has handed it over -- correct against a
   * BatchedMesh, which copies into its own buffers, and fatal against an
   * InstancedMesh, which draws the very object it was given.
   *
   * The clone is also where `aPropFade` goes, because an InstancedBufferAttribute
   * lives on the GEOMETRY rather than on the mesh -- so there is nowhere to put
   * it until this call, and every instance is stamped 1.0 (never fade), which is
   * the same resting value three gives a batch's colour alpha.
   */
  addGeometry(geometry) {
    if (this._geometrySet) {
      throw new Error('InstancedArena: one geometry only -- an instanced bed has no LOD ladder')
    }
    this._geometrySet = true
    this.geometry.dispose()
    this.geometry = geometry.clone()
    this.geometry.setAttribute(
      'aPropFade',
      new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(1), 1)
    )
    return 0
  }

  /**
   * Add a per-instance float the scatter's material reads as an attribute. Same
   * reason `aPropFade` is created above and not by the caller: an
   * InstancedBufferAttribute lives on the geometry, and the geometry the arena
   * actually draws is the clone made here.
   *
   * @param {number} fill  the resting value, stamped on every instance, so an
   *   id that no tile has grown yet still draws something sane.
   */
  addInstancedAttribute(name, fill) {
    if (!this._geometrySet) throw new Error('InstancedArena: addGeometry first')
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(fill), 1)
    this.geometry.setAttribute(name, attr)
    return attr
  }

  addInstance(geometryId) {
    if (geometryId !== 0) throw new Error(`InstancedArena: unknown geometry ${geometryId}`)
    if (this._next >= this._max) throw new Error('InstancedArena: pool exhausted')
    return this._next++
  }

  setGeometryIdAt(instanceId, geometryId) {
    if (geometryId !== 0) throw new Error(`InstancedArena: unknown geometry ${geometryId}`)
  }

  setMatrixAt(instanceId, matrix) {
    // THREE.InstancedMesh's OWN CONSTRUCTOR calls this once per instance to seed
    // the buffer with identity, and by the language's rules it does so before any
    // field below exists -- super() runs to completion first. Dropping those
    // writes is not tolerating a bug, it is the state this class wants: every
    // instance starts hidden, hidden means a ZERO matrix here, and a fresh
    // Float32Array is already zero.
    if (this._shadow === undefined) return
    matrix.toArray(this._shadow, instanceId * 16)
    if (this._visible[instanceId]) {
      super.setMatrixAt(instanceId, matrix)
      this.instanceMatrix.needsUpdate = true
    }
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this._shadow, instanceId * 16)
  }

  setColorAt(instanceId, color) {
    super.setColorAt(instanceId, color)
    this.instanceColor.needsUpdate = true
  }

  setVisibleAt(instanceId, visible) {
    const was = this._visible[instanceId]
    if (was === (visible ? 1 : 0)) return
    this._visible[instanceId] = visible ? 1 : 0
    const dst = this.instanceMatrix.array
    if (visible) {
      dst.set(this._shadow.subarray(instanceId * 16, instanceId * 16 + 16), instanceId * 16)
      if (instanceId >= this._highWater) {
        this._highWater = instanceId + 1
        this.count = this._highWater
      }
    } else {
      dst.fill(0, instanceId * 16, instanceId * 16 + 16)
    }
    this.instanceMatrix.needsUpdate = true
  }

  getVisibleAt(instanceId) {
    return this._visible[instanceId] === 1
  }

  dispose() {
    this.geometry.dispose()
    super.dispose()
    return this
  }
}
