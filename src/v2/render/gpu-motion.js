// ---------------------------------------------------------------------------
// GPU CREATURE MOTION: the machinery a layer shares to pose its instances in
// the vertex shader from plan data, so the CPU has nothing to do between the
// turns of a creature's plan.
//
// A creature's plan is a list of PHRASES (a seat, a crouch, a hop, a landing),
// each a closed-form curve of the time since its segment began. The CPU lays
// the plan (it needs the terrain) and writes it into one ROW of a float
// texture; the vertex shader reads the row for its instance, finds the phrase
// playing at the room's clock, evaluates it and builds the instance matrix.
// A row is rewritten only when the plan it holds runs out (`nextWake`).
//
// ROW LAYOUT (RGBA32F texels, ROW_W wide, one creature per row):
//   texel 0            header: segment start HI, LO, scale, phrase count
//   texel 1 + 4p + 0   phrase p: start (s into the segment), duration, kind, apex
//   texel 1 + 4p + 1                from / seat x, y, z, yaw
//   texel 1 + 4p + 2                to x, y, z, spare
//   texel 1 + 4p + 3                ground normal x, y, z, spare
// The segment start is split into a multiple of TIME_HI and a remainder: a
// float32 clock loses a tenth of a second past a few hundred thousand seconds.
//
// A layer supplies the GLSL that turns a phrase into a pose (its `body`, see
// motionSplice) and a JS twin of it for the gates; this file owns the table,
// the time uniforms and the splice that routes `instanceMatrix` to the result.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

export const ROW_W = 128
export const PHRASES_MAX = (ROW_W - 1) >> 2
export const TIME_HI = 1024

export class PhraseTable {
  constructor(rows) {
    this.rows = rows
    this.data = new Float32Array(ROW_W * rows * 4)
    this.texture = new THREE.DataTexture(this.data, ROW_W, rows, THREE.RGBAFormat, THREE.FloatType)
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    // Rows are patched into a texture only once it holds the whole table on the GPU; before that a range would leave the rest unwritten.
    this.uploaded = false
    this.texture.onUpdate = () => { this.uploaded = true }
    this.texture.needsUpdate = true
    this.pending = false
    this.uniforms = {
      uMotion: { value: this.texture },
      uMotionT: { value: new THREE.Vector2() },
      uMotionHead: { value: new THREE.Vector3() },
    }
  }

  /** Empty row `row`: a creature with no plan is not drawn. */
  clear(row) {
    this.data[row * ROW_W * 4 + 3] = 0
    this._range(row, 1)
  }

  /**
   * Write `phrases` into `row` for a segment that began at world second `start`: each
   * `{ kind, start, dur, apex, a: {x,y,z,yaw,nx,ny,nz}, b: {x,y,z} | null }` with `kind` the layer's code.
   */
  write(row, start, scale, phrases) {
    if (phrases.length > PHRASES_MAX) throw new Error(`PhraseTable: ${phrases.length} phrases, the row holds ${PHRASES_MAX}`)
    const d = this.data
    const o = row * ROW_W * 4
    const hi = Math.floor(start / TIME_HI) * TIME_HI
    d[o] = hi; d[o + 1] = start - hi; d[o + 2] = scale; d[o + 3] = phrases.length
    for (let p = 0; p < phrases.length; p++) {
      const ph = phrases[p]
      const q = o + 4 + p * 16
      d[q] = ph.start; d[q + 1] = ph.dur; d[q + 2] = ph.kind; d[q + 3] = ph.apex
      d[q + 4] = ph.a.x; d[q + 5] = ph.a.y; d[q + 6] = ph.a.z; d[q + 7] = ph.yaw
      const b = ph.b
      d[q + 8] = b ? b.x : 0; d[q + 9] = b ? b.y : 0; d[q + 10] = b ? b.z : 0; d[q + 11] = 0
      d[q + 12] = ph.a.nx; d[q + 13] = ph.a.ny; d[q + 14] = ph.a.nz; d[q + 15] = 0
    }
    this._range(row, 1 + phrases.length * 4)
  }

  _range(row, texels) {
    if (this.uploaded) this.texture.addUpdateRange(row * ROW_W * 4, texels * 4)
    this.pending = true
  }

  /** Hand the written rows to the GPU: the first upload is the whole table, later ones only the rows written. */
  flush() {
    if (!this.pending) return
    this.texture.needsUpdate = true
    this.pending = false
  }

  /** The clock the shader reads: world second `t` as a multiple of TIME_HI and its remainder. */
  setTime(t) {
    const hi = Math.floor(t / TIME_HI) * TIME_HI
    this.uniforms.uMotionT.value.set(hi, t - hi)
  }

  dispose() {
    this.texture.dispose()
  }
}

/**
 * Splice a motion into an InstancedMesh material's vertex shader (call it from the
 * material's onBeforeCompile). Every use of `instanceMatrix` -- three's own
 * transform, a card's spin -- reads the matrix `body` builds; a mesh that is
 * not instanced (the same material on a held copy) compiles untouched.
 *
 * `body` is GLSL for `mat4 gpuMotion(int row, vec4 head, float e)`'s inside:
 * `row` the texture row, `head` the header texel, `e` the seconds into the
 * segment; it may call `phraseAt(row, n, e)` (the index of the phrase playing)
 * and `texel(row, i)` (texel i of the row), and returns the matrix, or a
 * zero-scale one to hide the instance.
 */
export function motionSplice(shader, table, body) {
  Object.assign(shader.uniforms, table.uniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
#ifdef USE_INSTANCING
uniform sampler2D uMotion;
uniform vec2 uMotionT;
uniform vec3 uMotionHead;
attribute float aRow;
mat4 gpuInstanceMatrix;
vec4 texel( int row, int i ) { return texelFetch( uMotion, ivec2( i, row ), 0 ); }
int phraseAt( int row, int n, float e ) {
  int lo = 0;
  int hi = n - 1;
  for ( int i = 0; i < 5; i ++ ) {
    if ( lo >= hi ) break;
    int mid = ( lo + hi + 1 ) >> 1;
    if ( texel( row, 1 + 4 * mid ).x <= e ) lo = mid; else hi = mid - 1;
  }
  return lo;
}
mat4 gpuMotion() {
  int row = int( aRow + 0.5 );
  vec4 head = texel( row, 0 );
  int n = int( head.w + 0.5 );
  if ( n == 0 ) return mat4( 0.0 );
  float e = ( uMotionT.x - head.x ) + ( uMotionT.y - head.y );
  ${body}
}
#define instanceMatrix gpuInstanceMatrix
#endif`)
    .replace('void main() {', `void main() {
#ifdef USE_INSTANCING
gpuInstanceMatrix = gpuMotion();
#endif`)
}
