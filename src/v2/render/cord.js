import THREE from '../../three-instance.js'

// Cords: ropes drawn as camera-facing ribbons, two triangles a segment. Each frame's cords are polylines in world space, added afresh between begin() and end(). The vertex shader turns each one's strip to face the eye and spreads it `width` m wide, but never under `minPx` pixels, so a far one does not thin to nothing. Its normal is worked out per fragment as a cylinder's seen side on (across the strip it turns from one side, through the eye, to the other), so a lit material shades it round and smooth, and `uv` runs (metres along, 0..1 across) for a map.

const _vp = new THREE.Vector4()

export class Cords {
  /**
   * @param opts.most      the most cords a frame
   * @param opts.points    the points along each
   * @param opts.width     its width, m
   * @param opts.minPx     the narrowest it is drawn, px
   * @param opts.material  a MeshLambertMaterial or the like, its own: its onBeforeCompile is taken, so patch it (the lighting) after this
   * @param opts.name      the mesh's name
   */
  constructor(scene, { most, points, width, minPx, material, name }) {
    if (!(points >= 2)) throw new Error('Cords: needs at least 2 points a cord')
    if (material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) throw new Error('Cords: patch the material after making the cords, not before')
    this.most = most
    this.points = points
    const verts = most * points * 2
    this.pos = new Float32Array(verts * 3)
    this.tan = new Float32Array(verts * 3)
    this.uv = new Float32Array(verts * 2)
    const across = new Float32Array(verts), index = []
    for (let c = 0; c < most; c++) {
      for (let i = 0; i < points; i++) {
        const a = (c * points + i) * 2
        across[a] = -1
        across[a + 1] = 1
        // Wound to face the eye: the strip's side is cross(along, to the eye).
        if (i < points - 1) index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    const geo = (this.geo = new THREE.BufferGeometry())
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('cordAlong', new THREE.BufferAttribute(this.tan, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('cordAcross', new THREE.BufferAttribute(across, 1))
    // Never read (the shader makes its own), but with none three flat-shades a lit mesh, a hard line at every triangle.
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setIndex(index)
    geo.setDrawRange(0, 0)
    const u = { cordWidth: { value: width }, cordMinPx: { value: minPx }, cordViewH: { value: 1 } }
    this.uniforms = u
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u)
      shader.vertexShader = 'uniform float cordWidth;\nuniform float cordMinPx;\nuniform float cordViewH;\nattribute vec3 cordAlong;\nattribute float cordAcross;\nvarying float vCordAcross;\n' + shader.vertexShader
        .replace('#include <beginnormal_vertex>', `
          // World space: the mesh sits at the origin unturned.
          vec3 cordEye = normalize( cameraPosition - position );
          vec3 cordSide = cross( cordAlong, cordEye );
          float cordLen = length( cordSide );
          cordSide = cordLen > 1e-5 ? cordSide / cordLen : vec3( 0.0 );
          float cordDepth = -( modelViewMatrix * vec4( position, 1.0 ) ).z;
          // A pixel at that depth is 2 depth / (P[1][1] * the viewport's height) m.
          float cordHalf = max( 0.5 * cordWidth, cordMinPx * cordDepth / ( projectionMatrix[ 1 ][ 1 ] * cordViewH ) );
          // The side, for the fragment's cylinder normal (normal_fragment_begin below).
          vec3 objectNormal = cordSide;
          vCordAcross = cordAcross;
          #ifdef USE_TANGENT
            vec3 objectTangent = cordAlong;
          #endif`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += cordSide * cordAcross * cordHalf;')
      // A per-vertex normal interpolated across each quad's two triangles shows their diagonal as a hard line, so the round is made here, in view space.
      shader.fragmentShader = 'varying float vCordAcross;\n' + shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          float cordA = clamp( vCordAcross, -1.0, 1.0 );
          vec3 cordToEye = normalize( vViewPosition );
          vec3 cordS = normalize( vNormal );
          cordS = normalize( cordS - cordToEye * dot( cordS, cordToEye ) );
          normal = normalize( cordS * cordA + cordToEye * sqrt( max( 0.0, 1.0 - cordA * cordA ) ) );
          nonPerturbedNormal = normal;`)
    }
    material.customProgramCacheKey = () => 'v2-cord'
    const mesh = (this.mesh = new THREE.Mesh(geo, material))
    mesh.name = name
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    // The viewport being drawn: each eye's, in the headset.
    mesh.onBeforeRender = (renderer) => { renderer.getCurrentViewport(_vp); u.cordViewH.value = _vp.w }
    scene.add(mesh)
    this.n = 0
  }

  /** A new frame's cords. */
  begin() { this.n = 0 }

  /** A cord through `points` (x, y, z) triples in `xyz`; false once the frame has its most. */
  add(xyz) {
    if (this.n >= this.most) return false
    const P = this.points, o = this.n++ * P * 2, pos = this.pos, tan = this.tan, uv = this.uv
    let u = 0
    for (let i = 0; i < P; i++) {
      const a = i * 3, prev = Math.max(0, i - 1) * 3, next = Math.min(P - 1, i + 1) * 3
      let tx = xyz[next] - xyz[prev], ty = xyz[next + 1] - xyz[prev + 1], tz = xyz[next + 2] - xyz[prev + 2]
      const l = Math.hypot(tx, ty, tz) || 1
      tx /= l; ty /= l; tz /= l
      if (i > 0) u += Math.hypot(xyz[a] - xyz[a - 3], xyz[a + 1] - xyz[a - 2], xyz[a + 2] - xyz[a - 1])
      for (let s = 0; s < 2; s++) {
        const v = o + i * 2 + s
        pos[v * 3] = xyz[a]; pos[v * 3 + 1] = xyz[a + 1]; pos[v * 3 + 2] = xyz[a + 2]
        tan[v * 3] = tx; tan[v * 3 + 1] = ty; tan[v * 3 + 2] = tz
        uv[v * 2] = u; uv[v * 2 + 1] = s
      }
    }
    return true
  }

  /** The frame's cords to the GPU. */
  end() {
    const g = this.geo
    g.setDrawRange(0, this.n * (this.points - 1) * 6)
    for (const k of ['position', 'cordAlong', 'uv']) {
      const a = g.getAttribute(k)
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.n * this.points * 2 * a.itemSize)
      a.needsUpdate = true
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.geo.dispose()
    this.mesh.material.dispose()
  }
}
