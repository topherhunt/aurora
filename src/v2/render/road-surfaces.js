import THREE from '../../three-instance.js'
import { ribbonVertices, ROAD_LIFT } from './ribbon.js'

/**
 * The visible surface of every authored road: one ribbon per path of kind 'road'.
 *
 * IT DOES NOT HAVE TO FIT THE TERRAIN, BECAUSE THE TERRAIN HAS ALREADY FITTED IT. §18's road layer is a SMOOTH, not a carve: inside `halfWidth` the height field is replaced outright by the spline's own `y`, and over `feather` metres outward it lerps back to whatever the ground was doing. So by the time this mesh is built the ground under it is already a flat strip at exactly the elevation this ribbon wants, and the ribbon is a decal on it rather than a shape that has to be draped.
 *
 * That is also why this is a separate class from WaterSurfaces despite sharing the ribbon generator. A river is a surface at a level the terrain was cut BELOW; a road is a surface at a level the terrain was flattened TO. The first needs an overhang so its edge is buried, the second must not have one -- past `halfWidth` the smooth's feather starts lifting the ground back toward the hillside, and a widened road would push its own edge under that rise and vanish into it.
 */

// Packed dirt, LINEAR (three treats plain Color uniforms and vertex colours as working space, so this reads as roughly sRGB 0.3).
//
// Picked against src/terrain/terrain-material.js's palette rather than invented: it is that file's DIRT (0.075, 0.052, 0.028 -- "exposed soil and grit") carried a quarter of the way toward its GRIT (0.155, 0.152, 0.146 -- "pale mineral grain on rock"). A road is exactly that: the same soil the hillside is made of, compacted until the mineral grain in it shows. Anything cooler or paler reads as concrete poured across a wilderness. The two source colours are not exported, so they are quoted here; if the palette moves, this moves with it by hand.
const ROAD_COLOR = new THREE.Color(0.095, 0.077, 0.058)

// Tonal drift along the road, as a fraction of ROAD_COLOR, and the two wavelengths it is summed from in metres.
//
// A ribbon painted exactly one colour for three kilometres reads as a stripe laid ON the world rather than as a surface OF it, and the reason is that nothing else in this world is one colour -- the terrain material puts ~0.5 m grit and ~3.5 m patches on every hillside (§7). This is the same idea at the only resolution a 2 m-sampled ribbon can carry: two sines on arc length, at 17.3 m and 61.7 m so their ratio is nowhere near rational and they do not beat into a repeat, at +/-7% which is a dry patch rather than a stain.
const ROAD_DRIFT = 0.07
const DRIFT_LONG = 61.7
const DRIFT_SHORT = 17.3

export class RoadSurfaces {
  constructor({ scene, layers }) {
    if (!scene || !scene.isScene) throw new Error('RoadSurfaces needs the Scene')
    if (!layers || !layers.paths) throw new Error('RoadSurfaces needs Layers, for the path set')

    this.scene = scene
    this.layers = layers

    this.group = new THREE.Group()
    this.group.name = 'v2-road-surfaces'
    scene.add(this.group)

    /**
     * Lambert with vertex colours, and it needs WorldLighting.patch applied BY THE CALLER:
     *
     *   lighting.patch(roads.material, { mode: 'vertex', cacheKey: 'v2-road' })
     *
     * Vertex mode, like the props and the village -- fragment mode is the terrain's, and it costs a horizon-map tap per fragment to buy a shadow edge that a road at 2 m sample spacing has nowhere to put. Without the patch this material is the one surface in the world that neither the terrain's shadows nor the night lift reach, which does not show as a bug so much as a road that is inexplicably the brightest thing on a hillside after sunset.
     */
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true })
    this.material.name = 'v2-road'

    this.meshes = new Map()

    // The editor's per-object hide, as a predicate. Default: everything is drawn, so nothing outside the editor has to know this exists.
    this.isVisible = () => true

    this.triangles = 0
    this.epoch = -1
  }

  /**
   * `fn('road', id, null)` returning false for a road that should not be drawn. Hiding is `mesh.visible` rather than a skipped build, for the reason spelled out in WaterSurfaces.setVisibility: the road SMOOTH is baked into the terrain from the document, so a hidden road leaves its flattened strip behind either way, and rebuilding the set is not the cheap operation a button press should trigger.
   */
  setVisibility(fn) {
    if (typeof fn !== 'function') throw new Error('RoadSurfaces.setVisibility needs a (kind, id, index) => boolean')
    this.isVisible = fn
    this.applyVisibility()
  }

  applyVisibility() {
    for (const [id, mesh] of this.meshes) mesh.visible = this.isVisible('road', id, null) !== false
  }

  /** Every road, from scratch. Called when the epoch moves and nothing narrower is known. */
  rebuild() {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    this.meshes.clear()
    this.group.clear()
    this.triangles = 0

    // Reading segmentCount forces PathSet's lazy flatten for every dirty record. Same reasoning as WaterSurfaces.pathRecords, at length there.
    void this.layers.paths.segmentCount
    for (const path of this.layers.paths.paths.values()) {
      if (path.kind === 'road') this.buildRoad(path)
    }

    this.applyVisibility()
    this.epoch = this.layers.epoch
    return { roads: this.meshes.size, triangles: this.triangles }
  }

  /** One road, by id. The gizmo-drag path: dispose first, then build, or a rebuild per mousemove leaks a BufferGeometry per frame. */
  rebuildOne(id) {
    const old = this.meshes.get(id)
    if (old) {
      old.geometry.dispose()
      this.group.remove(old)
      this.meshes.delete(id)
      this.triangles -= old.userData.triangles
    }

    const path = this.layers.paths.paths.get(id)
    if (!path) throw new Error(`RoadSurfaces.rebuildOne: no path with id ${id}`)
    if (path.kind !== 'road') throw new Error(`RoadSurfaces.rebuildOne: path ${id} is a ${path.kind}, which belongs to WaterSurfaces`)
    this.buildRoad(path)
    this.applyVisibility()
  }

  buildRoad(road) {
    // PathSet's own baked polyline, never a fresh flatten of the spline: the road SMOOTH reads these samples to decide where to flatten the terrain, and a ribbon built from any other set of points would be a decal on a strip it does not quite match.
    // Unconditionally: a river whose level was re-solved keeps its samples array and rewrites the y in place, so a null check would miss it.
    void this.layers.paths.segmentCount
    if (road.samples === null) throw new Error(`RoadSurfaces: PathSet left ${road.id} unbaked; samples is still null after forcing the index`)
    // No widen: see the header. `lift` goes in here rather than into the mesh's y so the ribbon's own normals are computed on the surface that is actually drawn.
    const r = ribbonVertices(road.samples, { lift: ROAD_LIFT })

    // Vertex colours, keyed on arc length so the two vertices of a sample agree and the drift runs ALONG the road rather than across it. A cross-section gradient would want a third row of vertices down the crown, which is 50% more geometry than a ribbon this flat is worth.
    const colors = new Float32Array(r.vertices * 3)
    for (let i = 0; i < r.count; i++) {
      const u = r.arc[i]
      const k = 1 + ROAD_DRIFT * 0.5 * (Math.sin((u / DRIFT_LONG) * 2 * Math.PI) + Math.sin((u / DRIFT_SHORT) * 2 * Math.PI))
      const o = i * 6
      colors[o] = colors[o + 3] = ROAD_COLOR.r * k
      colors[o + 1] = colors[o + 4] = ROAD_COLOR.g * k
      colors[o + 2] = colors[o + 5] = ROAD_COLOR.b * k
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3))
    // u is METRES along the road, not 0..1. A normalised u over a 3 km road means a texture repeat of 3000 to tile at 1 m, and every one of those repeats has to be re-authored the moment a control point moves and the length changes. Metres are invariant to editing: add a point and only the vertices past it get new numbers.
    geo.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.material)
    mesh.name = `v2-road-${road.id}`
    mesh.userData.triangles = r.triangles
    mesh.userData.length = r.length
    this.group.add(mesh)
    this.meshes.set(road.id, mesh)
    this.triangles += r.triangles
  }

  dispose() {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    this.meshes.clear()
    this.group.clear()
    this.material.dispose()
    if (this.group.parent) this.group.parent.remove(this.group)
    this.triangles = 0
  }
}
