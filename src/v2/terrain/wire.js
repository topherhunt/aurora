import THREE from '../../three-instance.js'
import { CHUNK_RES, SLOT_COUNT } from '../config.js'
import { cellSize } from './stream-policy.js'

// ---------------------------------------------------------------------------
// The terrain's wireframe, a debug overlay: every drawn chunk's interior grid and
// the diagonal the mesher actually chose per quad, green where the chunk's cell
// is WIRE_COARSE_M or wider and blue where it is finer. It lives beside the
// terrain batch rather than on it, so the terrain row can be off and the lines
// still show what is resident and drawn.
//
// ONE INSTANCED LineSegments, every chunk the same base geometry. The edges of a
// CHUNK_RES grid are the same list for every chunk; what differs is where the
// chunk sits and its 289 heights, and those the terrain already keeps CPU-side
// for groundAt (TerrainV2.heightsArena, one row per slot). The arena is the
// backing store of a float texture here, so a chunk landing costs the overlay
// nothing until the next frame it is on, when the texture re-uploads once.
//
// THE DIAGONAL IS DECIDED IN THE SHADER by the mesher's own rule -- the shorter
// of the two, read off the four corner heights -- so the lines are the drawn
// triangulation and not a guess at it. A grid with the wrong diagonals reads
// as a ridge where the surface has a saddle.
//
// Lines sit ON the surface, so they are pulled 0.3% closer along the eye ray
// (same screen position, nearer depth). Proportional to distance because the
// depth buffer's resolution is, and GL polygon offset does not apply to lines.
// ---------------------------------------------------------------------------

/** Cell size, in metres, at and above which a chunk is drawn green; finer is blue. */
export const WIRE_COARSE_M = 8

const GRID_SIDE = CHUNK_RES + 1
const GRID_VERTS = GRID_SIDE * GRID_SIDE

// Vertex codes in aCell.z: a grid vertex at (i, j), or one end of quad (i, j)'s diagonal.
const GRID = 0
const DIAG_A = 1
const DIAG_B = 2

const GREEN = new THREE.Color(0.2, 1.0, 0.25)
const BLUE = new THREE.Color(0.25, 0.6, 1.0)

const VERT = /* glsl */ `
  attribute vec3 aCell;
  attribute vec4 iChunk; // origin x, origin z, size, heights row
  attribute float iDepth;
  uniform highp sampler2D uHeights;
  uniform float uBlueDepth;
  uniform vec3 uGreen;
  uniform vec3 uBlue;
  varying vec3 vColor;
  #include <logdepthbuf_pars_vertex>

  float H(int i, int j, int row) {
    return texelFetch(uHeights, ivec2(j * ${GRID_SIDE} + i, row), 0).r;
  }

  void main() {
    int i = int(aCell.x);
    int j = int(aCell.y);
    int row = int(iChunk.w);
    float h;
    if (aCell.z == ${GRID}.0) {
      h = H(i, j, row);
    } else {
      // The mesher's rule verbatim: a-d when |a-d| < |b-c|, else b-c.
      float a = H(i, j, row), b = H(i + 1, j, row), c = H(i, j + 1, row), d = H(i + 1, j + 1, row);
      bool ad = abs(a - d) < abs(b - c);
      if (aCell.z == ${DIAG_A}.0) { if (ad) { h = a; } else { i += 1; h = b; } }
      else { if (ad) { i += 1; j += 1; h = d; } else { j += 1; h = c; } }
    }
    float step = iChunk.z / ${CHUNK_RES}.0;
    vec3 p = vec3(iChunk.x + float(i) * step, h, iChunk.y + float(j) * step);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xyz *= 0.997;
    gl_Position = projectionMatrix * mv;
    vColor = iDepth < uBlueDepth ? uGreen : uBlue;
    #include <logdepthbuf_vertex>
  }
`

const FRAG = /* glsl */ `
  varying vec3 vColor;
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(vColor, 1.0);
  }
`

/** The base geometry's line vertices: the row and column edges, then one diagonal per quad. */
function cellAttribute() {
  const out = []
  for (let j = 0; j <= CHUNK_RES; j++) {
    for (let i = 0; i < CHUNK_RES; i++) out.push(i, j, GRID, i + 1, j, GRID, j, i, GRID, j, i + 1, GRID)
  }
  for (let j = 0; j < CHUNK_RES; j++) {
    for (let i = 0; i < CHUNK_RES; i++) out.push(i, j, DIAG_A, i, j, DIAG_B)
  }
  return new THREE.BufferAttribute(new Float32Array(out), 3)
}

export class TerrainWire {
  /** @param terrain a TerrainV2; the overlay reads its cache and shares its heights arena. */
  constructor(scene, terrain) {
    if (!terrain || !terrain.heightsArena) throw new Error('TerrainWire needs a TerrainV2 with a heights arena')
    this.scene = scene
    this.terrain = terrain

    this.texture = new THREE.DataTexture(terrain.heightsArena, GRID_VERTS, SLOT_COUNT, THREE.RedFormat, THREE.FloatType)
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter
    this.texture.needsUpdate = true
    this._uploaded = terrain.heightsVersion

    // The shallowest depth whose cell is finer than the green threshold.
    let blueDepth = 0
    while (cellSize(blueDepth) >= WIRE_COARSE_M) blueDepth++

    const geometry = new THREE.InstancedBufferGeometry()
    const cells = cellAttribute()
    geometry.setAttribute('aCell', cells)
    // No `position` attribute, so three has no vertex count to draw unless told.
    geometry.setDrawRange(0, cells.count)
    this._chunk = new THREE.InstancedBufferAttribute(new Float32Array(SLOT_COUNT * 4), 4).setUsage(THREE.DynamicDrawUsage)
    this._depth = new THREE.InstancedBufferAttribute(new Float32Array(SLOT_COUNT), 1).setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('iChunk', this._chunk)
    geometry.setAttribute('iDepth', this._depth)
    geometry.instanceCount = 0

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeights: { value: this.texture },
        uBlueDepth: { value: blueDepth },
        uGreen: { value: GREEN },
        uBlue: { value: BLUE },
      },
      // Writes depth: with the terrain hidden, nothing else keeps the water
      // plane under a hillside from blending over the lines above it.
      depthWrite: true,
      toneMapped: false,
    })
    this.material.name = 'v2-terrain-wire'

    this.mesh = new THREE.LineSegments(geometry, this.material)
    this.mesh.name = 'v2-terrain-wire'
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    scene.add(this.mesh)
  }

  get visible() { return this.mesh.visible }
  set visible(v) { this.mesh.visible = v }

  /** Rebuild the instance list from what the terrain is drawing this frame. Skipped while hidden. */
  update() {
    if (!this.mesh.visible) return
    const chunk = this._chunk.array
    const depth = this._depth.array
    let n = 0
    for (const entry of this.terrain.cache.values()) {
      if (!entry.slot || !entry.visible) continue
      const node = entry.node
      chunk[n * 4] = node.x
      chunk[n * 4 + 1] = node.z
      chunk[n * 4 + 2] = node.size
      chunk[n * 4 + 3] = entry.slot.row
      depth[n] = node.depth
      n++
    }
    this.mesh.geometry.instanceCount = n
    this._chunk.clearUpdateRanges()
    this._chunk.addUpdateRange(0, n * 4)
    this._chunk.needsUpdate = true
    this._depth.clearUpdateRanges()
    this._depth.addUpdateRange(0, n)
    this._depth.needsUpdate = true
    if (this._uploaded !== this.terrain.heightsVersion) {
      this._uploaded = this.terrain.heightsVersion
      this.texture.needsUpdate = true
    }
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
