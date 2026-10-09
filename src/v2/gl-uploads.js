// Counts what a frame sends to the GPU: buffer and texture uploads, as calls and bytes. The perf trace reads it
// per sample, so an upload-heavy layer shows as the difference between two states. `take()` returns the total
// since the last take and resets it.

const BUFFER_CALLS = ['bufferSubData', 'bufferData']
const TEXTURE_CALLS = ['texSubImage2D', 'texImage2D', 'texSubImage3D', 'texImage3D']

/** Bytes a data argument holds: `length` elements from `srcOffset` when a typed array is given with them, else the whole view; 0 for a size or a non-buffer source (an image's size is not known here). */
function bytesOf(data, srcOffset, length) {
  if (!ArrayBuffer.isView(data)) return data instanceof ArrayBuffer ? data.byteLength : 0
  if (data instanceof DataView) return data.byteLength
  return (length || data.length - (srcOffset || 0)) * data.BYTES_PER_ELEMENT
}

export class UploadCounter {
  constructor(gl) {
    this.calls = 0
    this.bytes = 0
    for (const name of BUFFER_CALLS) {
      const f = gl[name].bind(gl)
      gl[name] = (...args) => {
        this.calls++
        // bufferSubData(target, offset, data, srcOffset, length) and bufferData(target, data, usage, srcOffset, length).
        const [, a, b, c, d] = args
        this.bytes += name === 'bufferSubData' ? bytesOf(b, c, d) : bytesOf(a, c, d)
        return f(...args)
      }
    }
    for (const name of TEXTURE_CALLS) {
      const f = gl[name].bind(gl)
      gl[name] = (...args) => {
        this.calls++
        for (const arg of args) if (ArrayBuffer.isView(arg)) this.bytes += arg.byteLength
        return f(...args)
      }
    }
  }

  take() {
    const out = { calls: this.calls, bytes: this.bytes }
    this.calls = 0
    this.bytes = 0
    return out
  }
}
