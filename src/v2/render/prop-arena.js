import THREE from '../../three-instance.js'

// ---------------------------------------------------------------------------
// THE PROP ARENA. A BatchedMesh-shaped facade over a GROUP of InstancedMeshes,
// one per (tier, variant), so a scatter -- which touches the arena API from a
// dozen places of its own and four inside rim.js -- does not have to know which
// of the two it is holding.
//
// IT IS INSTANCED BECAUSE A BatchedMesh IS NOT FASTER ON A QUEST 2, and that is
// a measurement rather than a preference: the same grass bed runs at
// single-digit fps batched and at fifty-plus instanced, on identical geometry.
// render/instanced-arena.js is the same trade for a scatter that needs only ONE
// geometry; this is the version that carries a ladder and a bank.
//
// A geometry id is `tier * variantCount + variant`, which is also the index of
// the mesh that draws it. An instance id is a POOL id, owned by the scatter and
// unrelated to the slot it currently occupies inside a mesh -- so every
// per-instance value is shadowed here and rewritten when a slot moves.
//
// WHAT THE SHAPE COSTS, and it is the number that decides whether a layer
// belongs on this class at all: ONE DRAW CALL PER MESH, so `tiers x variants`
// draw calls for the layer where a batch had one. The forest ships 4 variants
// at 4 tiers and pays sixteen; a bank of ninety would pay two hundred and
// seventy and there would be no argument left. A scatter moving onto this class
// collapses its bank to ONE VARIANT PER SPECIES first and puts the rest of its
// variety in the instance matrix -- yaw, uniform scale, lean -- which is free.
//
// PACKING IS DENSE AND HIDING IS A SWAP-REMOVE. An InstancedMesh draws a
// contiguous `count`, so the only way to skip a hidden instance is for it not to
// be inside it: `count` IS a mesh's live population, and freeing a slot moves
// the last one down into the hole. So `renderer.info` reports the props actually
// on screen and a pool sized for the worst case does not bill for its headroom.
//
// NO PER-INSTANCE FRUSTUM CULLING. There is none to have, so the menu's
// cull row does nothing to a layer built on this: everything behind the player
// is submitted every frame.
//
// A PATTERN IS EMERGING HERE AND IT IS WORTH NAMING: this class, the rim
// dissolve in rim.js, the thinning law in tile-pool.js and the cross-dissolve
// bookkeeping now duplicated in trees.js, rocks.js, grass.js and ferns.js
// together add up to a HAND-ROLLED BatchedMesh -- per-instance geometry,
// per-instance visibility, dense packing, distance thinning and dithered
// transitions, over an API three gives us but does not run acceptably on the
// target headset. Two arenas (this and instanced-arena.js, plus a private copy
// of the second inside grass.js) and FOUR copies of `_crossFade` is where that
// stands. The piece most worth lifting out next is the cross-dissolve, which is
// the same sixty lines of pool-and-clock bookkeeping in every bed and holds the
// only invariant that is expensive to get wrong (a ghost that outlives its
// window is a leaked slot, and a pool running dry throws) -- the shape it would
// take, and what each bed does differently, is worked out in
// design/attic/lod-cross-fade-extraction.md. The placement and ladder halves are
// NOT the same and should not be forced together -- see the class header in
// rocks.js for a ladder measured in object sizes against the metre bands here.
//
// A NOTE FOR ANYONE ADDING A MESH: three compiles a different program for an
// InstancedMesh whose `instanceColor` is null than for one whose is not. Every
// mesh makes its own in the constructor, so they agree by construction and a
// tiered bank costs one compile rather than one per mesh.
// ---------------------------------------------------------------------------
export class PropArena extends THREE.Group {
  /**
   * @param maxInstances  the pool size, and the length of every shadow array.
   * @param tiers         bank.tiers -- `tiers[t].geometries[v]`. TAKEN, not
   *                      copied: an InstancedMesh draws the object it is given,
   *                      so the caller must not dispose these.
   * @param caps          per-tier instance capacity of ONE mesh. Exceeding it
   *                      throws rather than silently dropping a prop.
   * @param material      shared by every mesh, so the bank is one program; or
   *                      a function `(t, v) => Material` for a bank whose
   *                      variants wear their own maps (gen-props.js).
   * @param name          the group's name, and the stem of every mesh's.
   * @param layerShift    attach `aLayerShift` to every geometry, for a material
   *                      compiled with `layerShift: true`: the per-instance
   *                      offset added to the geometry's `texLayer`, 0 at rest.
   */
  constructor(maxInstances, tiers, caps, material, name, { layerShift = false } = {}) {
    const materialFor = typeof material === 'function' ? material : () => material
    super()
    this.name = name
    this.frustumCulled = false
    // Neither is real on an InstancedMesh, but main.js's applyBatchCulling reads
    // both off every batch it is handed and would otherwise record `undefined`
    // as this layer's default.
    this.perObjectFrustumCulled = false
    this.sortObjects = false

    const variantCount = tiers[0].geometries.length
    this.variantCount = variantCount
    this.meshes = []
    this.owner = []
    this.capAt = []
    for (let t = 0; t < tiers.length; t++) {
      if (tiers[t].geometries.length !== variantCount) {
        throw new Error(
          `PropArena: tier ${t} holds ${tiers[t].geometries.length} geometries, tier 0 holds ${variantCount}`
        )
      }
      for (let v = 0; v < variantCount; v++) {
        const cap = caps[t]
        const geo = tiers[t].geometries[v]
        // aPropFade lives on the GEOMETRY, so it can only be attached once the
        // geometry is spoken for. 1 is "never fade", the resting value
        // setPropSolidAt writes and the one a batch's colour alpha starts at.
        geo.setAttribute(
          'aPropFade',
          new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1)
        )
        if (layerShift) {
          geo.setAttribute('aLayerShift', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1))
        }
        const mesh = new THREE.InstancedMesh(geo, materialFor(t, v), cap)
        mesh.name = `${name}-t${t}-v${v}`
        // Nothing is drawn until an instance takes a slot; `count` is the live
        // population from here on.
        mesh.count = 0
        // An InstancedMesh's own frustum test computes a bounding sphere over
        // every instance matrix, which is both expensive and stale the moment a
        // tile grows. The scatter follows the camera and the answer would be yes
        // in any case.
        mesh.frustumCulled = false
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        // Created here rather than left to three's lazy path inside setColorAt,
        // so USE_INSTANCING_COLOR is defined on the FIRST compile -- a material
        // that compiled without it would drop the per-instance tint until
        // something forced a rebuild.
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(cap * 3).fill(1), 3
        )
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
        this.meshes.push(mesh)
        this.owner.push(new Int32Array(cap))
        this.capAt.push(cap)
        this.add(mesh)
      }
    }

    this._max = maxInstances
    this._next = 0
    this.geoAt = new Int32Array(maxInstances).fill(-1)
    this.slot = new Int32Array(maxInstances).fill(-1)
    this.vis = new Uint8Array(maxInstances)
    this.mat = new Float32Array(maxInstances * 16)
    this.col = new Float32Array(maxInstances * 3).fill(1)
    this.fade = new Float32Array(maxInstances).fill(1)
    this.layer = layerShift ? new Float32Array(maxInstances) : null
  }

  addInstance(geometryId) {
    if (this._next >= this._max) throw new Error(`${this.name}: pool exhausted`)
    const id = this._next++
    this.geoAt[id] = geometryId
    return id
  }

  setGeometryIdAt(instanceId, geometryId) {
    if (this.geoAt[instanceId] === geometryId) return
    if (this.slot[instanceId] >= 0) this._free(instanceId)
    this.geoAt[instanceId] = geometryId
    if (this.vis[instanceId]) this._alloc(instanceId)
  }

  setVisibleAt(instanceId, visible) {
    const want = visible ? 1 : 0
    if (this.vis[instanceId] === want) return
    this.vis[instanceId] = want
    if (want) {
      if (this.geoAt[instanceId] >= 0) this._alloc(instanceId)
    } else if (this.slot[instanceId] >= 0) {
      this._free(instanceId)
    }
  }

  getVisibleAt(instanceId) {
    return this.vis[instanceId] === 1
  }

  setMatrixAt(instanceId, matrix) {
    matrix.toArray(this.mat, instanceId * 16)
    const s = this.slot[instanceId]
    if (s < 0) return
    const mesh = this.meshes[this.geoAt[instanceId]]
    matrix.toArray(mesh.instanceMatrix.array, s * 16)
    mesh.instanceMatrix.needsUpdate = true
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this.mat, instanceId * 16)
    return matrix
  }

  setColorAt(instanceId, color) {
    color.toArray(this.col, instanceId * 3)
    const s = this.slot[instanceId]
    if (s < 0) return
    const mesh = this.meshes[this.geoAt[instanceId]]
    color.toArray(mesh.instanceColor.array, s * 3)
    mesh.instanceColor.needsUpdate = true
  }

  getColorAt(instanceId, color) {
    return color.fromArray(this.col, instanceId * 3)
  }

  /** The write side of material.js's writeFadeSlot; see the hook there. */
  setFadeSlotAt(instanceId, value) {
    this.fade[instanceId] = value
    const s = this.slot[instanceId]
    if (s < 0) return
    const attr = this.meshes[this.geoAt[instanceId]].geometry.getAttribute('aPropFade')
    attr.array[s] = value
    attr.needsUpdate = true
  }

  /** The instance's layer offset; the arena must have been built with `layerShift`. */
  setLayerShiftAt(instanceId, value) {
    if (!this.layer) throw new Error(`${this.name}: built without layerShift`)
    this.layer[instanceId] = value
    const s = this.slot[instanceId]
    if (s < 0) return
    const attr = this.meshes[this.geoAt[instanceId]].geometry.getAttribute('aLayerShift')
    attr.array[s] = value
    attr.needsUpdate = true
  }

  /**
   * Free slots left in the mesh that draws `geometryId`.
   *
   * For a caller about to put a SECOND instance somewhere on purpose -- the
   * duplicate an LOD cross-dissolve holds in the departing tier's mesh, which
   * the tier's own cap was never sized for. A mesh that fills THROWS in _alloc,
   * so a duplicate has to ask before it takes; refusing one costs a pop and
   * nothing else.
   */
  roomAt(geometryId) {
    return this.capAt[geometryId] - this.meshes[geometryId].count
  }

  /** Take the next free slot in this instance's mesh and fill it from shadow. */
  _alloc(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = mesh.count
    if (s >= this.capAt[g]) {
      throw new Error(`PropArena: mesh ${mesh.name} is full at ${this.capAt[g]} instances`)
    }
    mesh.count = s + 1
    this.owner[g][s] = instanceId
    this.slot[instanceId] = s
    this._writeSlot(instanceId)
  }

  /**
   * Give the slot back, moving the mesh's LAST instance down into the hole so
   * the drawn range stays contiguous. The mover is rewritten from shadow rather
   * than copied slot-to-slot, because that is one code path for both the move
   * and the initial fill and cannot disagree with itself.
   */
  _free(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = this.slot[instanceId]
    const last = mesh.count - 1
    mesh.count = last
    this.slot[instanceId] = -1
    if (s === last) return
    const moved = this.owner[g][last]
    this.owner[g][s] = moved
    this.slot[moved] = s
    this._writeSlot(moved)
  }

  _writeSlot(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = this.slot[instanceId]
    mesh.instanceMatrix.array.set(
      this.mat.subarray(instanceId * 16, instanceId * 16 + 16), s * 16
    )
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.array.set(
      this.col.subarray(instanceId * 3, instanceId * 3 + 3), s * 3
    )
    mesh.instanceColor.needsUpdate = true
    const attr = mesh.geometry.getAttribute('aPropFade')
    attr.array[s] = this.fade[instanceId]
    attr.needsUpdate = true
    if (this.layer) {
      const shift = mesh.geometry.getAttribute('aLayerShift')
      shift.array[s] = this.layer[instanceId]
      shift.needsUpdate = true
    }
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      mesh.dispose()
    }
    return this
  }
}
