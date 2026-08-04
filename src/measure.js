import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Click-to-measure: a red beam on the ground and a distance readout.
//
// This is a tuning instrument, not a game mechanic. Judging scale by eye in a
// procedural landscape is genuinely hard -- "is that ridge 400 m away or 4 km"
// has no reliable answer without a reference, and the whole terrain retune
// turns on being able to answer it. Click a hillside, read the number.
//
// The hit test raymarches the height field directly rather than raycasting the
// rendered mesh, and that is the load-bearing choice. Terrain lives in a pooled
// BatchedMesh whose geometry is the CURRENT LOD selection: a raycast would
// report the surface as tessellated at that distance, so the same rock would
// measure differently depending on how far away you happened to be standing --
// which is exactly the error a measuring tool cannot make. `heightAt()` is the
// authoritative surface and is LOD-independent by construction. It also means
// this works on chunks that have not finished streaming in.
// ---------------------------------------------------------------------------

const MAX_DIST = 8000 // past this the fog has swallowed everything anyway
const BEAM_HEIGHT = 90
const BEAM_RADIUS = 0.35
const RING_RADIUS = 2.5
const RED = 0xff3b30

// Marches until the ray passes below the surface, then bisects. The step grows
// with distance so a 8 km ray is ~900 samples rather than 8000, and near the
// camera -- where you are most likely to be measuring something small -- it
// stays at 1 m. This runs once per click, not per frame; there is no reason to
// be clever about it.
function raymarch(terrain, o, d) {
  let prevT = 0.5
  if (o.y + d.y * prevT - terrain.heightAt(o.x + d.x * prevT, o.z + d.z * prevT) <= 0) {
    return null // eye is already inside the terrain; nothing sensible to report
  }

  let t = prevT
  while (t < MAX_DIST) {
    t += Math.max(1.0, t * 0.01)
    if (o.y + d.y * t - terrain.heightAt(o.x + d.x * t, o.z + d.z * t) > 0) {
      prevT = t
      continue
    }

    // Straddled it. 24 halvings of a <=80 m bracket lands well under a
    // millimetre, which is far finer than anything downstream cares about.
    let lo = prevT
    let hi = t
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) * 0.5
      if (o.y + d.y * mid - terrain.heightAt(o.x + d.x * mid, o.z + d.z * mid) > 0) lo = mid
      else hi = mid
    }
    const x = o.x + d.x * hi
    const z = o.z + d.z * hi
    return { x, z, y: terrain.heightAt(x, z) }
  }

  return null // sky, or a ray that skimmed the whole world without touching it
}

export class Measure {
  constructor(scene, terrainHeight) {
    this.terrain = terrainHeight
    this.hit = null

    const mat = new THREE.MeshBasicMaterial({
      color: RED,
      // Fog off on purpose: everything else in the scene is meant to fade with
      // distance, and this one thing is meant not to. A marker you cannot see
      // at 2 km cannot help you judge 2 km.
      fog: false,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
    })

    const beamGeo = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, BEAM_HEIGHT, 6, 1, true)
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0) // pivot at the base, so it stands on the hit
    const ringGeo = new THREE.RingGeometry(RING_RADIUS * 0.7, RING_RADIUS, 20)
    ringGeo.rotateX(-Math.PI / 2)
    ringGeo.translate(0, 0.15, 0) // clear of the surface it is sitting on

    this.group = new THREE.Group()
    this.group.add(new THREE.Mesh(beamGeo, mat))
    this.group.add(new THREE.Mesh(ringGeo, mat))
    this.group.visible = false
    this.group.renderOrder = 5
    scene.add(this.group)

    this._o = new THREE.Vector3()
    this._d = new THREE.Vector3()
    this._raycaster = new THREE.Raycaster()
  }

  // ndc is the click in normalised device coordinates (-1..1 on both axes).
  // Returns true if it landed on ground.
  measure(camera, ndc) {
    this._raycaster.setFromCamera(ndc, camera)
    this._o.copy(this._raycaster.ray.origin)
    this._d.copy(this._raycaster.ray.direction).normalize()

    const hit = raymarch(this.terrain, this._o, this._d)
    if (!hit) {
      this.clear()
      return false
    }

    this.hit = hit
    this.group.position.set(hit.x, hit.y, hit.z)
    this.group.visible = true
    return true
  }

  clear() {
    this.hit = null
    this.group.visible = false
  }

  // One HUD line, or null. `%%` is the HUD's measurement colour (red).
  //
  // Measured against the CURRENT eye, not the eye at click time. That makes it
  // a live rangefinder rather than a frozen receipt: plant a beam on a ridge,
  // walk toward it, and watch the number come down. Calibrating your own sense
  // of distance needs the walk, not the snapshot.
  line(eye) {
    if (!this.hit) return null
    const dx = this.hit.x - eye.x
    const dy = this.hit.y - eye.y
    const dz = this.hit.z - eye.z
    const horiz = Math.hypot(dx, dz)
    const slant = Math.hypot(horiz, dy)
    // Slant first because that is the distance the eye actually perceives, but
    // horizontal and vertical are both there: on a mountainside they diverge
    // hard, and "800 m away" means very different things at 0 deg and 40 deg.
    return `%% measure ${slant.toFixed(0)}m   horiz ${horiz.toFixed(0)}m   dv ${dy >= 0 ? '+' : ''}${dy.toFixed(0)}m`
  }
}
