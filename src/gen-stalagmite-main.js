import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { stalagmite, stalagmiteCard } from './v2/caves/stalagmite.js'
import { mulberry32 } from './sim/mathx.js'
import { ROCK_TILE_MEAN } from './textures.js'

// The stalagmite bench (gen-stalagmite.html): the seed's dripstone standing and hanging at its full size, its far card beside it turning to face the eye, and a bunch of other seeds, in the cave's triplanar stone under one warm key light.

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x05080f)
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200)
camera.position.set(4, 2.6, 8.5)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(1, 1.6, -1)

const stone = new THREE.TextureLoader().load('rocks/stone.png')
stone.colorSpace = THREE.SRGBColorSpace
stone.wrapS = stone.wrapT = THREE.RepeatWrapping
// The cave's dripstone shading (cave-room.js DRIP): the stone tile triplanar, turned a quarter on the sides; with CARD, the far card's coverage and rounded shade over it.
const dripMaterial = (defines, uniforms) => new THREE.ShaderMaterial({
  uniforms: { uStone: { value: stone }, ...uniforms },
  defines,
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vP = w.xyz;
  mat3 m = mat3(modelMatrix * instanceMatrix);
  vN = normalize(m * (normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]))));
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D uStone;
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
#ifdef CARD
uniform sampler2D uCard;
#endif
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  vec2 s = vec2(1.0 / 2.2);
  vec3 t = texture2D(uStone, vP.yz * s).rgb * w.x + texture2D(uStone, vP.xz * s).rgb * w.y + texture2D(uStone, vP.yx * s).rgb * w.z;
  vec3 alb = vec3(0.17, 0.165, 0.15) * mix(vec3(1.0), t / vec3(${ROCK_TILE_MEAN.map((v) => v.toFixed(4)).join(', ')}), 0.85);
#ifdef CARD
  vec4 card = texture2D(uCard, vUv);
  if (card.a < 0.5) discard;
  alb *= card.r;
#endif
  vec3 key = normalize(vec3(0.5, 0.8, 0.4));
  vec3 lit = vec3(1.0, 0.75, 0.5) * 3.0 * max(dot(n, key), 0.0) + vec3(0.25, 0.3, 0.4) * (0.6 + 0.4 * n.y);
  gl_FragColor = vec4(alb * lit, 1.0);
  #include <colorspace_fragment>
}`,
})
const material = dripMaterial({})

// The floor the stalagmites stand on and the slab of roof the stalactites hang from.
const ROOF_Y = 4
const slab = new THREE.MeshBasicMaterial({ color: 0x141210, side: THREE.DoubleSide })
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(14, 8).rotateX(-Math.PI / 2), slab))
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(14, 3).rotateX(Math.PI / 2).translate(1.5, ROOF_Y, -2), slab))

const stats = document.getElementById('stats')
const seedInput = document.getElementById('seed')
let group = null
let card = null
let wire = false

function geometryOf(seed) {
  const { position, index } = stalagmite(seed)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  return g
}

// One instanced mesh per seed: rows of [x, y, z, radius, length, down].
function place(seed, rows) {
  const mesh = new THREE.InstancedMesh(geometryOf(seed), material, rows.length)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3()
  rows.forEach(([x, y, z, r, len, down], i) => {
    q.setFromEuler(new THREE.Euler(down ? Math.PI : 0, i * 1.7, 0))
    mesh.setMatrixAt(i, m.compose(p.set(x, y, z), q, s.set(r, len, r)))
  })
  return mesh
}

function rebuild() {
  if (group !== null) {
    scene.remove(group)
    group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose() })
    card.material.uniforms.uCard.value.dispose()
    card.material.dispose()
  }
  group = new THREE.Group()
  const seed = Number(seedInput.value)
  group.add(place(seed, [[0, 0, 0, 0.45, 2.2, false], [-2, ROOF_Y, -2, 0.35, 2.4, true]]))
  // Its card at the same size, as the cave draws it past 20 m (cave-room.js).
  const c = stalagmiteCard(seed, 32, 64)
  const tex = new THREE.DataTexture(c.data, 32, 64)
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  card = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(2 * c.half * 0.45, (1 - c.y0) * 2.2).translate(0, ((1 + c.y0) / 2) * 2.2, 0),
    dripMaterial({ CARD: '' }, { uCard: { value: tex } }),
    1,
  )
  card.position.set(1.4, 0, 0)
  group.add(card)
  // A bunch: a lead stalactite and smaller ones round it, a stalagmite under some, as props.js places them, all of the one seed as the cave draws them.
  const rand = mulberry32(seed * 7919 + 1)
  for (let j = 0; j < 7; j++) {
    const a = rand() * Math.PI * 2, d = j === 0 ? 0 : 1.2 * Math.sqrt(rand()), size = j === 0 ? 1 : 0.3 + 0.6 * rand()
    const x = 3.5 + Math.cos(a) * d, z = -2 + Math.sin(a) * d
    const rows = [[x, ROOF_Y, z, 0.2 * size, 1.6 * size, true]]
    if (rand() < 0.55) rows.push([x, 0, z, 0.25 * size, 1.1 * size, false])
    group.add(place(seed, rows))
  }
  scene.add(group)
  const g = stalagmite(seed)
  stats.textContent = `${g.index.length / 3} triangles, ${g.position.length / 3} vertices`
}

seedInput.addEventListener('input', rebuild)
document.getElementById('reroll').addEventListener('click', () => { seedInput.value = Math.floor(Math.random() * 1e6); rebuild() })
document.getElementById('wire').addEventListener('click', (e) => {
  wire = !wire
  e.target.classList.toggle('on', wire)
  material.wireframe = wire
})

function resize() {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
rebuild()
renderer.setAnimationLoop(() => {
  controls.update()
  card.rotation.y = Math.atan2(camera.position.x - card.position.x, camera.position.z - card.position.z)
  renderer.render(scene, camera)
})
