import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// A castle dungeon's iron key (items.js kind 'key'), built here rather than shipped: a ring bow at +Z, the shank along -Z and its
// bit hanging below the far end, centred, ITEMS.key.size long.

/** The key's geometry, vertex-coloured, and its material. */
export function buildKey() {
  const paint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.toArray(a, i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(a, 3))
    return g
  }
  const IRON = 0x55504a
  const bow = new THREE.TorusGeometry(0.022, 0.006, 6, 12).rotateY(Math.PI / 2).translate(0, 0, 0.048)
  const shank = new THREE.CylinderGeometry(0.0045, 0.0045, 0.1, 6).rotateX(Math.PI / 2).translate(0, 0, -0.022)
  const bit = new THREE.BoxGeometry(0.005, 0.022, 0.018).translate(0, -0.012, -0.06)
  const collar = new THREE.CylinderGeometry(0.007, 0.007, 0.006, 6).rotateX(Math.PI / 2).translate(0, 0, 0.024)
  const geometry = mergeGeometries([bow, shank, bit, collar].map((g) => paint(g.toNonIndexed(), IRON)))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return { geometry, material: new THREE.MeshLambertMaterial({ vertexColors: true }) }
}
