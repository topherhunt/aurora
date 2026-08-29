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
//   NO PER-INSTANCE FRUSTUM CULLING. There is none to have, so the /?quest
//   panel's cull row does nothing to a layer built on this: the two thirds of
//   the disc behind the player are submitted every frame.
//
//   PACKING IS DENSE AND HIDING IS A SWAP-REMOVE. An InstancedMesh draws a
//   contiguous `count`, so the only way to skip a hidden instance is for it not
//   to be inside it. The arena keeps `_owner`, slot -> id, and `count` IS the
//   live population: hiding an instance moves the last slot's instance down into
//   the hole. So `renderer.info` reports the props actually on screen, a
//   rim-hidden prop costs nothing at all, and a pool sized for the worst case
//   does not bill for its headroom.
//
//   WHAT THAT COSTS is that an instance's slot is not stable, so every
//   per-instance value needs a shadow copy here and a moved instance is
//   rewritten from it -- matrix, tint, fade stamp and any extra attribute.
//   Nothing outside may index a GPU buffer by instance id; go through the
//   setters, which know the difference.
//
//   The rim's dissolve is NOT on that list, and getting it back is what made
//   this shippable rather than a diagnostic. instanceColor is itemSize 3 in
//   three r180, so there is no alpha beside the tint to hide a timer in; the
//   arena carries `aPropFade` instead, one float per instance, and material.js
//   reads it through FADE_VERTEX's instancing branch. That is cheaper than the
//   batched path it replaces -- an attribute fetch where the batch did a vertex
//   TEXTURE fetch.
//
// A NOTE FOR ANYONE PUTTING A SECOND ARENA ON ONE MATERIAL: three compiles a
// different program for an InstancedMesh whose `instanceColor` is null than for
// one whose is not. Every arena makes its own in the constructor, so they agree
// by construction and a tiered scatter costs one compile rather than one per
// ring.
// ---------------------------------------------------------------------------
export class InstancedArena extends THREE.InstancedMesh {
  constructor(maxInstances, material) {
    // Geometry arrives through addGeometry, so a scatter's constructor makes the
    // same calls in the same order whichever of the two it is building.
    super(new THREE.BufferGeometry(), material, maxInstances)
    this._max = maxInstances
    this._next = 0
    this._geometrySet = false
    // THE SHADOWS, one per value the GPU buffers hold. A slot is not stable --
    // _free moves the last live instance down into the hole -- so no buffer can
    // be the source of truth for anything, and a moved instance is rewritten
    // from here. `_extra` carries whatever addInstancedAttribute hands out.
    this._shadow = new Float32Array(maxInstances * 16)
    this._tint = new Float32Array(maxInstances * 3).fill(1)
    this._fade = new Float32Array(maxInstances).fill(1)
    this._extra = []
    this._fadeAttr = null
    this._visible = new Uint8Array(maxInstances)
    // id -> slot, -1 while the instance is not drawn, and slot -> id over the
    // live range [0, count).
    this._slot = new Int32Array(maxInstances).fill(-1)
    this._owner = new Int32Array(maxInstances).fill(-1)
    this.count = 0
    this.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Made here rather than left to three's lazy path inside setColorAt, because
    // _writeSlot has to be able to move a tint before anyone has set one.
    this.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3).fill(1), 3)
    this.instanceColor.setUsage(THREE.DynamicDrawUsage)
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
    this._fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(1), 1)
    this.geometry.setAttribute('aPropFade', this._fadeAttr)
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
   *
   * Write it through setAttrAt and never into `.array` directly: the returned
   * attribute is indexed by SLOT, and only the shadow registered here survives
   * the instance being moved.
   */
  addInstancedAttribute(name, fill) {
    if (!this._geometrySet) throw new Error('InstancedArena: addGeometry first')
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(fill), 1)
    this.geometry.setAttribute(name, attr)
    this._extra.push({ attr, shadow: new Float32Array(this._max).fill(fill) })
    return attr
  }

  /** Set one of addInstancedAttribute's floats for an instance ID. */
  setAttrAt(attr, instanceId, value) {
    const extra = this._extra.find((e) => e.attr === attr)
    if (!extra) {
      throw new Error('InstancedArena: setAttrAt on an attribute it did not make')
    }
    extra.shadow[instanceId] = value
    const s = this._slot[instanceId]
    if (s >= 0) {
      extra.attr.array[s] = value
      extra.attr.needsUpdate = true
    }
  }

  /** Read one back by instance ID, from the shadow rather than the buffer. */
  getAttrAt(attr, instanceId) {
    const extra = this._extra.find((e) => e.attr === attr)
    if (!extra) {
      throw new Error('InstancedArena: getAttrAt on an attribute it did not make')
    }
    return extra.shadow[instanceId]
  }

  /** Where an instance's data currently sits, or -1 while it is not drawn. */
  slotOf(instanceId) {
    return this._slot[instanceId]
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
    // writes is not tolerating a bug, it is the state this class wants: nothing
    // is drawn until a slot is taken, and an untaken instance has no slot to
    // seed.
    if (this._shadow === undefined) return
    matrix.toArray(this._shadow, instanceId * 16)
    const s = this._slot[instanceId]
    if (s >= 0) {
      matrix.toArray(this.instanceMatrix.array, s * 16)
      this.instanceMatrix.needsUpdate = true
    }
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this._shadow, instanceId * 16)
  }

  setColorAt(instanceId, color) {
    color.toArray(this._tint, instanceId * 3)
    const s = this._slot[instanceId]
    if (s >= 0) {
      color.toArray(this.instanceColor.array, s * 3)
      this.instanceColor.needsUpdate = true
    }
  }

  getColorAt(instanceId, color) {
    color.fromArray(this._tint, instanceId * 3)
  }

  /**
   * The dissolve stamp. material.js's writeFadeSlot routes through this rather
   * than writing `aPropFade` itself, exactly as it does for TreeArena, because
   * only the arena knows which slot an instance is standing in.
   */
  setFadeSlotAt(instanceId, value) {
    this._fade[instanceId] = value
    const s = this._slot[instanceId]
    if (s >= 0) {
      this._fadeAttr.array[s] = value
      this._fadeAttr.needsUpdate = true
    }
  }

  setVisibleAt(instanceId, visible) {
    const want = visible ? 1 : 0
    if (this._visible[instanceId] === want) return
    this._visible[instanceId] = want
    if (want) this._alloc(instanceId)
    else this._free(instanceId)
  }

  getVisibleAt(instanceId) {
    return this._visible[instanceId] === 1
  }

  /** Take the slot at the top of the live range and fill it from the shadows. */
  _alloc(instanceId) {
    const s = this.count
    if (s >= this._max) {
      throw new Error(`InstancedArena: more than ${this._max} instances visible at once`)
    }
    this.count = s + 1
    this._owner[s] = instanceId
    this._slot[instanceId] = s
    this._writeSlot(instanceId)
  }

  /** Give a slot back, moving the last live instance down into the hole. */
  _free(instanceId) {
    const s = this._slot[instanceId]
    const last = this.count - 1
    this.count = last
    this._slot[instanceId] = -1
    if (s === last) return
    const moved = this._owner[last]
    this._owner[s] = moved
    this._slot[moved] = s
    this._writeSlot(moved)
  }

  /** Every per-instance buffer, rewritten from the shadows at the current slot. */
  _writeSlot(instanceId) {
    const s = this._slot[instanceId]
    this.instanceMatrix.array.set(
      this._shadow.subarray(instanceId * 16, instanceId * 16 + 16), s * 16)
    this.instanceMatrix.needsUpdate = true
    this.instanceColor.array.set(
      this._tint.subarray(instanceId * 3, instanceId * 3 + 3), s * 3)
    this.instanceColor.needsUpdate = true
    this._fadeAttr.array[s] = this._fade[instanceId]
    this._fadeAttr.needsUpdate = true
    for (const e of this._extra) {
      e.attr.array[s] = e.shadow[instanceId]
      e.attr.needsUpdate = true
    }
  }

  dispose() {
    this.geometry.dispose()
    super.dispose()
    return this
  }
}
