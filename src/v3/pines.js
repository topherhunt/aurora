import THREE from '../three-instance.js'
import { buildTreeBank, bakeTreeImpostors, treeImpostorLayers } from '../props/tree-bank.js'
import { createPropMaterial } from '../material.js'

// ---------------------------------------------------------------------------
// A yardstick for /terrain-v3: the game's pine, one in every SPACING-metre cell of a grid over the whole island, standing anywhere in its cell, so the ground's size can be read against a thing whose size is known. Not the forest -- no scatter, no thinning, no rim fade -- just the bank's three tiers handed out by distance and cut dead at CULL.
// ---------------------------------------------------------------------------

/** A cell's own random in -1..1, the same every time it is asked. */
function cellRand(i, j, salt) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

export const PINES = {
  spacing: 50,        // metres between trunks: one tree per spacing^2, each standing anywhere in its own cell
  scatter: 0.9,       // how much of its cell a tree may wander off the cell's centre, 0 for rows
  height: 9,          // metres, root to tip
  bands: [100, 300],  // LOD0 inside the first, LOD1 to the second, the billboard card beyond
  cull: 1000,         // metres; past this nothing is drawn
  sink: 0.15,         // metres of trunk buried so a tree on a slope does not float
  restep: 5,          // metres the head moves before the grid is walked again
}

export class Pines {
  /**
   * @param scene         THREE.Scene.
   * @param textureArray  The prop atlas from buildTextureArray(); the cards are photographs into it, taken by `bakeCards` once its image layers have landed.
   * @param heightAt      (x, z) -> metres; a tree stands wherever this is above the sea.
   */
  constructor(scene, textureArray, heightAt) {
    if (typeof heightAt !== 'function') throw new Error('Pines: needs heightAt(x, z)')
    this.heightAt = heightAt
    this.textureArray = textureArray

    const bank = buildTreeBank({ billboard: true })
    if (bank.tiers.length !== 3) throw new Error(`Pines: the bank has ${bank.tiers.length} tiers, wanted LOD0, LOD1 and the card`)
    const measured = bank.tiers[0].geometries[0].userData.tree.height
    if (!(measured > 0)) throw new Error(`Pines: the pine measures ${measured} m tall`)
    this.scale = PINES.height / measured

    this.material = createPropMaterial(textureArray, {
      billboardLayers: treeImpostorLayers(),
      vertexColors: true,
      wind: 'tree',
    })

    // Every grid point inside the cull disc, with a ring to spare, fits each tier: the meshes are sized once and never grow.
    const across = 2 * Math.ceil(PINES.cull / PINES.spacing) + 2
    this.capacity = across * across
    this.meshes = bank.tiers.map((tier, t) => {
      const mesh = new THREE.InstancedMesh(tier.geometries[0], this.material, this.capacity)
      mesh.name = `v3-pines-lod${t}`
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      return mesh
    })
    // The card is a picture nobody has taken yet: hidden until bakeCards.
    this.meshes[2].visible = false
    this.group = new THREE.Group()
    this.group.name = 'v3-pines'
    this.group.add(...this.meshes)
    scene.add(this.group)

    this.heights = new Map()
    this.last = { x: NaN, z: NaN }
    this.drawn = [0, 0, 0]
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._p = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
  }

  bakeCards(renderer) {
    bakeTreeImpostors(renderer, this.textureArray)
    this.meshes[2].visible = true
    this.last.x = NaN
  }

  /** Walk the grid round the head and hand every tree to the tier its distance earns. Only when the head has moved RESTEP metres since the last walk. */
  update(head) {
    if (Math.hypot(head.x - this.last.x, head.z - this.last.z) < PINES.restep) return
    this.last.x = head.x
    this.last.z = head.z
    const S = PINES.spacing
    const [b0, b1] = PINES.bands
    const counts = [0, 0, 0]
    const i0 = Math.floor((head.x - PINES.cull) / S)
    const i1 = Math.ceil((head.x + PINES.cull) / S)
    const j0 = Math.floor((head.z - PINES.cull) / S)
    const j1 = Math.ceil((head.z + PINES.cull) / S)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5 * PINES.scatter * cellRand(i, j, 1)) * S
        const z = (j + 0.5 * PINES.scatter * cellRand(i, j, 2)) * S
        const d = Math.hypot(x - head.x, z - head.z)
        if (d > PINES.cull) continue
        const y = this._groundAt(i, j, x, z)
        if (y <= 0) continue
        const t = d < b0 ? 0 : d < b1 ? 1 : 2
        const n = counts[t]
        if (n >= this.capacity) throw new Error(`Pines: tier ${t} is full at ${this.capacity}`)
        this._q.setFromAxisAngle(this._up, Math.PI * cellRand(i, j, 3))
        this._p.set(x, y - PINES.sink, z)
        this._s.setScalar(this.scale)
        this._m.compose(this._p, this._q, this._s)
        this.meshes[t].setMatrixAt(n, this._m)
        counts[t] = n + 1
      }
    }
    for (let t = 0; t < 3; t++) {
      this.meshes[t].count = counts[t]
      this.meshes[t].instanceMatrix.needsUpdate = true
    }
    this.drawn = counts
  }

  _groundAt(i, j, x, z) {
    const key = i * 65536 + j
    let y = this.heights.get(key)
    if (y === undefined) {
      y = this.heightAt(x, z)
      this.heights.set(key, y)
    }
    return y
  }
}
