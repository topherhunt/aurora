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
// TWO CLASSES, BECAUSE THE MESHES AND THE IDS HAVE DIFFERENT OWNERS. PropMeshes
// is the mesh set: the InstancedMeshes, their caps, and which instance sits in
// each slot. PropArena is a VIEW onto one: the id space and the per-instance
// shadow a scatter writes through. A layer that is one scatter builds a
// PropArena and gets a mesh set of its own (trees, mushrooms, deadwood); a layer
// that is SEVERAL scatters of the same bank -- the six rock beds -- builds one
// PropMeshes and a view per scatter, so six scatters cost the draw calls of
// one. Every id-level call is the same in either case, which is what lets
// rim.js and rocks.js not know the difference.
//
// A geometry id is `tier * variantCount + variant`, which is also the index of
// the mesh that draws it. An instance id is a POOL id, owned by the view and
// unrelated to the slot it currently occupies inside a mesh -- so every
// per-instance value is shadowed in the view and rewritten when a slot moves.
// A mesh slot names its occupant as (view, id), since the last slot a swap-remove
// pulls down may belong to another view.
//
// WHAT THE SHAPE COSTS, and it is the number that decides whether a layer
// belongs on this class at all: ONE DRAW CALL PER MESH, so `tiers x variants`
// draw calls for the mesh set where a batch had one. The forest ships 4 variants
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
// AND ONLY THE SLOTS WRITTEN ARE UPLOADED. Three uploads a flagged attribute
// whole unless it is told a range, and a mesh shared by six scatters is six
// times the buffer for one scatter's write. So every slot write widens ONE
// range on the attribute it wrote, held in three's own `updateRanges` list:
// three empties that list when it uploads (from `projectObject`, before any
// onBeforeRender fires, so no hook can flush late enough), and an empty list at
// the next write is how the range knows to start over. Per attribute, not per
// mesh, because three consumes each attribute's list only when THAT attribute's
// version moved, and a matrix write alone leaves the colour list standing.
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
// window is a leaked slot) -- the shape it would
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

// Geometry ids at or above this belong to the card set; no view without one reaches it.
const NO_CARDS = 0x3fffffff

/**
 * The mesh set: one InstancedMesh per (tier, variant), the slot bookkeeping and
 * the dirty spans. Not a scene object -- the owner adds `meshes` to whatever
 * group it shows them in (a PropArena adds them to itself).
 */
export class PropMeshes {
  /**
   * @param tiers         bank.tiers -- `tiers[t].geometries[v]`. TAKEN, not
   *                      copied: an InstancedMesh draws the object it is given,
   *                      so the caller must not dispose these.
   * @param caps          per-tier instance capacity of ONE mesh. A mesh that is
   *                      full REFUSES: see PropArena.setVisibleAt and
   *                      setGeometryIdAt.
   * @param material      shared by every mesh, so the bank is one program; or
   *                      a function `(t, v) => Material` for a bank whose
   *                      variants wear their own maps (gen-props.js).
   * @param name          the stem of every mesh's name.
   * @param layerShift    attach `aLayerShift` to every geometry, for a material
   *                      compiled with `layerShift: true`: the per-instance
   *                      offset added to the geometry's `texLayer`, 0 at rest.
   */
  constructor(tiers, caps, material, name, { layerShift = false } = {}) {
    const materialFor = typeof material === 'function' ? material : () => material
    this.name = name
    const variantCount = tiers[0].geometries.length
    this.variantCount = variantCount
    this.layerShift = layerShift
    this.meshes = []
    this.owner = []
    this.ownerView = []
    this.capAt = []
    for (let t = 0; t < tiers.length; t++) {
      if (tiers[t].geometries.length !== variantCount) {
        throw new Error(
          `PropMeshes: tier ${t} holds ${tiers[t].geometries.length} geometries, tier 0 holds ${variantCount}`
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
        this.ownerView.push(new Array(cap).fill(null))
        this.capAt.push(cap)
      }
    }
    // One reusable range per attribute per mesh, in the attribute's own
    // elements; `_dirty` widens it and re-lists it after three has consumed it.
    this._matRange = this.meshes.map(() => ({ start: 0, count: 0 }))
    this._colRange = this.meshes.map(() => ({ start: 0, count: 0 }))
    this._fadeRange = this.meshes.map(() => ({ start: 0, count: 0 }))
    this._layerRange = layerShift ? this.meshes.map(() => ({ start: 0, count: 0 })) : null
    /** Shows and tier moves a full mesh turned away, for the readouts. */
    this.refused = 0
    this._warned = new Uint8Array(this.meshes.length)
  }

  /**
   * Free slots left in the mesh that draws `geometryId`.
   *
   * For a caller about to put a SECOND instance somewhere on purpose -- the
   * duplicate an LOD cross-dissolve holds in the departing tier's mesh, which
   * the tier's own cap was never sized for. A duplicate asks before it takes so
   * the refusal lands on the ghost, a pop, and not on the next real arrival.
   */
  roomAt(geometryId) {
    return this.capAt[geometryId] - this.meshes[geometryId].count
  }

  /** Whether the mesh can take one more; counts and warns the first refusal per mesh. */
  _room(geometryId) {
    if (this.meshes[geometryId].count < this.capAt[geometryId]) return true
    this.refused++
    if (!this._warned[geometryId]) {
      this._warned[geometryId] = 1
      console.warn(`PropMeshes: mesh ${this.meshes[geometryId].name} is full at ${this.capAt[geometryId]} instances; showing nothing more in it`)
    }
    return false
  }

  /** Take the next free slot in the instance's mesh and fill it from the view's shadow. The caller has asked `_room`. */
  _alloc(view, instanceId) {
    const g = view.localAt(instanceId)
    const mesh = this.meshes[g]
    const s = mesh.count
    mesh.count = s + 1
    this.owner[g][s] = instanceId
    this.ownerView[g][s] = view
    view.slot[instanceId] = s
    this._writeSlot(view, instanceId)
  }

  /**
   * Give the slot back, moving the mesh's LAST instance down into the hole so
   * the drawn range stays contiguous. The mover is rewritten from its own view's
   * shadow rather than copied slot-to-slot, because that is one code path for
   * both the move and the initial fill and cannot disagree with itself -- and
   * because the mover may be another view's instance altogether.
   */
  _free(view, instanceId) {
    const g = view.localAt(instanceId)
    const mesh = this.meshes[g]
    const s = view.slot[instanceId]
    const last = mesh.count - 1
    mesh.count = last
    view.slot[instanceId] = -1
    if (s === last) return
    const moved = this.owner[g][last]
    const movedView = this.ownerView[g][last]
    this.owner[g][s] = moved
    this.ownerView[g][s] = movedView
    movedView.slot[moved] = s
    this._writeSlot(movedView, moved)
  }

  _writeSlot(view, instanceId) {
    const g = view.localAt(instanceId)
    const mesh = this.meshes[g]
    const s = view.slot[instanceId]
    mesh.instanceMatrix.array.set(
      view.mat.subarray(instanceId * 16, instanceId * 16 + 16), s * 16
    )
    this._dirty(mesh.instanceMatrix, this._matRange[g], s, 16)
    mesh.instanceColor.array.set(
      view.col.subarray(instanceId * 3, instanceId * 3 + 3), s * 3
    )
    this._dirty(mesh.instanceColor, this._colRange[g], s, 3)
    const attr = mesh.geometry.getAttribute('aPropFade')
    attr.array[s] = view.fade[instanceId]
    this._dirty(attr, this._fadeRange[g], s, 1)
    if (this.layerShift) {
      const shift = mesh.geometry.getAttribute('aLayerShift')
      shift.array[s] = view.layer[instanceId]
      this._dirty(shift, this._layerRange[g], s, 1)
    }
  }

  /**
   * Flag `attr` for upload and widen its one range, `w` elements per slot, to
   * take slot `s`. Three empties `updateRanges` when it uploads, so an empty
   * list means the range is spent and starts again at this slot.
   */
  _dirty(attr, range, s, w) {
    const ranges = attr.updateRanges
    const start = s * w
    if (ranges.length === 0) {
      range.start = start
      range.count = w
      ranges.push(range)
    } else {
      const end = Math.max(range.start + range.count, start + w)
      if (start < range.start) range.start = start
      range.count = end - range.start
    }
    attr.needsUpdate = true
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      mesh.dispose()
    }
    return this
  }
}

/**
 * A scatter's view onto a mesh set: its pool of ids and the shadow of every
 * per-instance value. Built standalone it makes a mesh set of its own and shows
 * it as its children; built `over` a shared set it shows nothing itself and
 * the set's owner does.
 */
export class PropArena extends THREE.Group {
  /**
   * @param maxInstances  the pool size, and the length of every shadow array.
   * @param tiers, caps, material, name, opts   as PropMeshes, for the standalone
   *                      form; `opts.shared` is the shared form and the rest are
   *                      then ignored (see `over`).
   * @param opts.cards    a PropMeshes (litter-cards.js) that draws the geometry
   *                      ids from `cardBase` up, one id per mesh of that set, so
   *                      several layers' far cards are one draw call. The set is
   *                      built with `layerShift`: the instance's picture is
   *                      `setLayerShiftAt`, and it rides in the view's shadow
   *                      across every tier change.
   */
  constructor(maxInstances, tiers, caps, material, name, { layerShift = false, shared = null, cards = null, cardBase = NO_CARDS } = {}) {
    super()
    this.name = name
    this.frustumCulled = false

    this._owns = !shared
    if (shared) {
      this.shared = shared
    } else {
      this.shared = new PropMeshes(tiers, caps, material, name, { layerShift })
      for (const mesh of this.shared.meshes) this.add(mesh)
    }
    if (cards && !cards.layerShift) throw new Error(`${name}: the card set must be built with layerShift`)
    this.cards = cards
    this.cardBase = cards ? cardBase : NO_CARDS
    this.meshes = this.shared.meshes
    this.capAt = this.shared.capAt
    this.variantCount = this.shared.variantCount

    this._max = maxInstances
    this._next = 0
    this.geoAt = new Int32Array(maxInstances).fill(-1)
    this.slot = new Int32Array(maxInstances).fill(-1)
    this.vis = new Uint8Array(maxInstances)
    this.mat = new Float32Array(maxInstances * 16)
    this.col = new Float32Array(maxInstances * 3).fill(1)
    this.fade = new Float32Array(maxInstances).fill(1)
    this.layer = this.shared.layerShift || cards ? new Float32Array(maxInstances) : null
  }

  /** A view of `maxInstances` ids over a mesh set another view, or the owner, shows. */
  static over(shared, maxInstances, name, opts = {}) {
    return new PropArena(maxInstances, null, null, null, name, { ...opts, shared })
  }

  /** The mesh set that draws geometry id `g`: the layer's own, or the shared cards. */
  _setFor(g) {
    return g >= this.cardBase ? this.cards : this.shared
  }

  _localOf(g) {
    return g >= this.cardBase ? g - this.cardBase : g
  }

  /** The index of instance `instanceId`'s mesh within the set that draws it. */
  localAt(instanceId) {
    return this._localOf(this.geoAt[instanceId])
  }

  addInstance(geometryId) {
    if (this._next >= this._max) throw new Error(`${this.name}: pool exhausted`)
    const id = this._next++
    this.geoAt[id] = geometryId
    return id
  }

  /**
   * Move the instance to another mesh. A visible instance whose new mesh is
   * FULL stays where it is and this returns false: the caller keeps the tier it
   * had, which is a rock a rung too coarse rather than a rock missing. The cap
   * is a bound on the tier's population (see rocks.js `_tierCaps`), so this
   * fires only when the world outruns the numbers the cap was set from, and it
   * says so once per mesh.
   */
  setGeometryIdAt(instanceId, geometryId) {
    const from = this.geoAt[instanceId]
    if (from === geometryId) return true
    const to = this._setFor(geometryId)
    if (this.vis[instanceId] && !to._room(this._localOf(geometryId))) return false
    if (this.slot[instanceId] >= 0) this._setFor(from)._free(this, instanceId)
    this.geoAt[instanceId] = geometryId
    if (this.vis[instanceId]) to._alloc(this, instanceId)
    return true
  }

  /** Show or hide. A show into a full mesh leaves the instance hidden and returns false. */
  setVisibleAt(instanceId, visible) {
    const want = visible ? 1 : 0
    if (this.vis[instanceId] === want) return true
    const g = this.geoAt[instanceId]
    if (want) {
      if (g >= 0 && !this._setFor(g)._room(this._localOf(g))) return false
      this.vis[instanceId] = 1
      if (g >= 0) this._setFor(g)._alloc(this, instanceId)
    } else {
      this.vis[instanceId] = 0
      if (this.slot[instanceId] >= 0) this._setFor(g)._free(this, instanceId)
    }
    return true
  }

  getVisibleAt(instanceId) {
    return this.vis[instanceId] === 1
  }

  setMatrixAt(instanceId, matrix) {
    matrix.toArray(this.mat, instanceId * 16)
    const s = this.slot[instanceId]
    if (s < 0) return
    const g = this.geoAt[instanceId]
    const set = this._setFor(g)
    const l = this._localOf(g)
    const mesh = set.meshes[l]
    matrix.toArray(mesh.instanceMatrix.array, s * 16)
    set._dirty(mesh.instanceMatrix, set._matRange[l], s, 16)
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this.mat, instanceId * 16)
    return matrix
  }

  setColorAt(instanceId, color) {
    color.toArray(this.col, instanceId * 3)
    const s = this.slot[instanceId]
    if (s < 0) return
    const g = this.geoAt[instanceId]
    const set = this._setFor(g)
    const l = this._localOf(g)
    const mesh = set.meshes[l]
    color.toArray(mesh.instanceColor.array, s * 3)
    set._dirty(mesh.instanceColor, set._colRange[l], s, 3)
  }

  getColorAt(instanceId, color) {
    return color.fromArray(this.col, instanceId * 3)
  }

  /** The write side of material.js's writeFadeSlot; see the hook there. */
  setFadeSlotAt(instanceId, value) {
    this.fade[instanceId] = value
    const s = this.slot[instanceId]
    if (s < 0) return
    const g = this.geoAt[instanceId]
    const set = this._setFor(g)
    const l = this._localOf(g)
    const attr = set.meshes[l].geometry.getAttribute('aPropFade')
    attr.array[s] = value
    set._dirty(attr, set._fadeRange[l], s, 1)
  }

  /** The instance's layer offset (or card picture); the mesh set that draws it must have been built with `layerShift`. */
  setLayerShiftAt(instanceId, value) {
    if (!this.layer) throw new Error(`${this.name}: built without layerShift`)
    this.layer[instanceId] = value
    const s = this.slot[instanceId]
    if (s < 0) return
    const g = this.geoAt[instanceId]
    const set = this._setFor(g)
    if (!set.layerShift) return
    const l = this._localOf(g)
    const attr = set.meshes[l].geometry.getAttribute('aLayerShift')
    attr.array[s] = value
    set._dirty(attr, set._layerRange[l], s, 1)
  }

  /** See PropMeshes.roomAt. */
  roomAt(geometryId) {
    return this._setFor(geometryId).roomAt(this._localOf(geometryId))
  }

  /** Disposes the mesh set. A view over a shared set leaves that to the set's owner. */
  dispose() {
    if (this._owns) this.shared.dispose()
    return this
  }
}
