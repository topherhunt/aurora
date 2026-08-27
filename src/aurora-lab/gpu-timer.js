// ---------------------------------------------------------------------------
// Real milliseconds, or an honest refusal.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
//
// Every cost claim in this subsystem so far has been a HAND COUNT of ALU operations in a shader, and hand counts turned out to be worthless as predictors: four algorithms whose counted costs differ by 9x to 17x all render at the same 10-15 fps in a real browser. A number that does not move when the thing it claims to measure moves by an order of magnitude is not a measurement, it is a story. This file replaces the story with a clock.
//
// The clock that matters is on the GPU. Wall-clock frame time cannot answer "what does the aurora pass cost" because the CPU submits a frame and returns long before the GPU has drawn it, so a frame delta measures the slowest link in a pipeline you do not control -- vsync, the compositor, another tab -- and attributes all of it to whatever you happened to change. `EXT_disjoint_timer_query_webgl2` is the only thing in WebGL that timestamps the GPU's own command stream.
//
// ===========================================================================
// WHEN THE EXTENSION IS NOT THERE
// ===========================================================================
//
// It very often is not. Safari has never exposed it, Chrome on a Metal-backed Mac usually does not, and SwiftShader does not. So the fallback matters as much as the primary path, and the one thing it must never do is produce a plausible-looking number of the same shape and let it be mistaken for a GPU timing. Everything this class returns therefore carries `mode`, and `label` is a sentence you can paste into a report.
//
// The fallback brackets the region with a 1x1 `gl.readPixels`, not with `gl.finish()` and not with frame-time divided by draw calls. `finish()` is the obvious choice and it does not work -- see `_measureBarrier` for the measurement that killed it. A readPixels cannot be answered without the pixels existing, so it blocks until the GPU has produced them, which turns "GPU work in this region" into a wall-clock interval this thread can read. That is a real interval containing real GPU work, biased UPWARD by the pipeline bubble it creates and by the fixed cost of the round trip, which is why it is labelled `cpu-sync` and not `gpu`. It is nevertheless the right fallback here, because the question the lab asks is always comparative -- is leyline cheaper than ribbon, is 16 steps cheaper than 40 -- and a constant additive bias does not change the ordering. Dividing a frame delta by `renderer.info.render.calls` would answer a different question badly: it assumes every draw costs the same, which for a scene of one raymarched quad plus a starfield is exactly the assumption that is false.
//
// ===========================================================================
// WHY REGIONS TAKE TURNS INSTEAD OF NESTING
// ===========================================================================
//
// There is at most one `TIME_ELAPSED_EXT` query active per context, so "aurora" cannot be measured inside "frame". Rather than pretend otherwise, `beginFrame` arms exactly ONE region per frame and round-robins across the registered names, so two regions each get a sample every other frame. That costs latency to fill the window and nothing else, and it means a caller can bracket overlapping regions freely: the ones that are not armed compile down to a name check.
//
// The median, not the mean. A single hitch -- a shader recompile, a texture upload, the compositor stealing the GPU -- is one sample two orders of magnitude out, and a mean over sixty samples carries that hitch forever at 1/60th weight. The median discards it. Everything in this lab that a person will act on is a comparison between two medians.
//
// ===========================================================================
// ASYNC CORRECTNESS
// ===========================================================================
//
// A timer query's result is NOT available in the frame that issued it -- the GPU has not run the commands yet. Reading it must be a poll on `QUERY_RESULT_AVAILABLE`, and a poll that spins would stall the very pipeline being measured, so the live path polls once per frame and lets results arrive whenever they arrive.
//
// `GPU_DISJOINT_EXT` is the other half. The GPU clock can be reset out from under a query -- a power state change, a context switch to another process -- and when that happens EVERY timing in flight is garbage, not just one. Reading the flag clears it, so it is read exactly once per frame and, when set, the entire pending set is discarded. A disjoint sample kept is worse than a sample lost: it is usually a wildly small number, which reads as "the optimisation worked".
// ---------------------------------------------------------------------------

// Sixty samples of a per-frame region is one second of a smooth 60 Hz frame, or two seconds when two regions are sharing the timer. Long enough that the median is stable, short enough that the readout still responds when a slider moves.
const DEFAULT_WINDOW = 60

// A one-shot measurement that has not resolved in this long has hit a driver that advertises the extension and is not going to answer, which is a real configuration and not a hypothetical -- see measureAsync. Throw, so the caller can fall back and SAY it fell back.
const SYNC_POLL_TIMEOUT_MS = 5000

// Yield to the event loop so the browser can actually submit the command buffer. rAF is what the compositor drives off, and it is the turn that gets a WebGL frame to the GPU; the timeout beside it is there because a headless or backgrounded page may never paint, and a benchmark that hangs forever waiting for a frame nobody is showing is worse than one that is a millisecond less exact.
function nextTurn() {
  return new Promise( ( resolve ) => {
    const t = setTimeout( resolve, 16 )
    requestAnimationFrame( () => { clearTimeout( t ); resolve() } )
  } )
}

export class GpuTimer {
  constructor( renderer, opts = {} ) {
    if ( !renderer || !renderer.isWebGLRenderer ) throw new Error( 'GpuTimer: needs a WebGLRenderer' )
    const regions = opts.regions
    if ( !Array.isArray( regions ) || regions.length === 0 ) throw new Error( 'GpuTimer: needs a non-empty `regions` list -- the round-robin has to know the names up front' )

    this._renderer = renderer
    this._gl = renderer.getContext()
    this._window = opts.window === undefined ? DEFAULT_WINDOW : opts.window
    if ( !Number.isFinite( this._window ) || this._window < 1 ) throw new Error( 'GpuTimer: window must be a positive frame count, got ' + opts.window )

    // WebGL1 has a different extension name and a different disjoint story, and nothing in this project runs on it -- three r180 asks for WebGL2 and fails hard without it. Say so rather than silently taking the fallback path for the wrong reason.
    this._webgl2 = typeof WebGL2RenderingContext !== 'undefined' && this._gl instanceof WebGL2RenderingContext
    // `forceCpu` is not a debug switch. An extension can be PRESENT and not work -- ANGLE over SwiftShader advertises this one and then never signals QUERY_RESULT_AVAILABLE -- and the only way to find that out is to try it. A caller that has tried and been let down needs a way to say so, because the alternative is a bench that hangs on a driver whose timer is decorative.
    this._ext = ( this._webgl2 && !opts.forceCpu ) ? this._gl.getExtension( 'EXT_disjoint_timer_query_webgl2' ) : null

    this.mode = this._ext ? 'gpu' : 'cpu-sync'
    this.label = this._ext
      ? 'GPU (EXT_disjoint_timer_query_webgl2)'
      : 'CPU-ESTIMATED (' + ( opts.forceCpu ? 'GPU timer refused, forced off by the caller' : 'no GPU timer on this browser' ) + '; readPixels barrier, biased high)'

    this._regions = regions.slice()
    this._samples = new Map()
    for ( const name of this._regions ) this._samples.set( name, [] )

    this._frame = 0
    this._armed = null
    this._open = null
    this._openStart = 0
    this._openQuery = null
    this._pending = []
    this._disjointDrops = 0
    this._inFrame = false
    this._barrierPixel = new Uint8Array( 4 )
  }

  // -------------------------------------------------------------------------

  // Call once at the top of the frame. Picks the region this frame will time.
  beginFrame() {
    if ( this._inFrame ) throw new Error( 'GpuTimer: beginFrame() called twice without endFrame()' )
    this._inFrame = true
    this._armed = this._regions[ this._frame % this._regions.length ]
    this._frame++
  }

  begin( name ) {
    if ( !this._samples.has( name ) ) throw new Error( 'GpuTimer: no region "' + name + '" -- register it in the constructor' )
    if ( !this._inFrame ) throw new Error( 'GpuTimer: begin("' + name + '") outside a beginFrame()/endFrame() pair' )
    if ( name !== this._armed ) return
    // Not a warning and not a skip. Two overlapping regions armed in the same frame would silently measure the outer one twice, and the round-robin makes that impossible, so reaching here means a caller changed the arming rule and needs to know.
    if ( this._open ) throw new Error( 'GpuTimer: region "' + name + '" opened inside "' + this._open + '" -- timer queries cannot nest' )

    this._open = name
    if ( this._ext ) {
      const q = this._gl.createQuery()
      this._gl.beginQuery( this._ext.TIME_ELAPSED_EXT, q )
      this._openQuery = q
    } else {
      // A barrier here drains whatever was already queued so it is not charged to this region. The one in end() is what makes the interval mean anything at all. See _measureBarrier for why it is a readPixels and not a finish().
      this._barrier()
      this._openStart = performance.now()
    }
  }

  end( name ) {
    if ( !this._samples.has( name ) ) throw new Error( 'GpuTimer: no region "' + name + '" -- register it in the constructor' )
    if ( name !== this._armed ) return
    if ( this._open !== name ) throw new Error( 'GpuTimer: end("' + name + '") with "' + this._open + '" open' )

    if ( this._ext ) {
      this._gl.endQuery( this._ext.TIME_ELAPSED_EXT )
      this._pending.push( { name, query: this._openQuery } )
      this._openQuery = null
    } else {
      this._barrier()
      this._push( name, performance.now() - this._openStart )
    }
    this._open = null
  }

  // Call once at the bottom of the frame, after the last render. Harvests whatever the GPU has finished answering.
  endFrame() {
    if ( !this._inFrame ) throw new Error( 'GpuTimer: endFrame() without beginFrame()' )
    if ( this._open ) throw new Error( 'GpuTimer: region "' + this._open + '" still open at endFrame()' )
    this._inFrame = false
    if ( !this._ext ) return

    // Read once per frame: the read is what clears the flag, so checking it per query would clear it on the first one and report false for the rest.
    if ( this._gl.getParameter( this._ext.GPU_DISJOINT_EXT ) ) {
      this._disjointDrops += this._pending.length
      for ( const p of this._pending ) this._gl.deleteQuery( p.query )
      this._pending.length = 0
      return
    }

    const still = []
    for ( const p of this._pending ) {
      if ( !this._gl.getQueryParameter( p.query, this._gl.QUERY_RESULT_AVAILABLE ) ) { still.push( p ); continue }
      this._push( p.name, this._gl.getQueryParameter( p.query, this._gl.QUERY_RESULT ) / 1e6 )
      this._gl.deleteQuery( p.query )
    }
    this._pending = still
  }

  // -------------------------------------------------------------------------

  // ---- One-shot measurement of a callback, for a benchmark rather than a frame loop.
  //
  // It is ASYNC and it has to be. A timer query does not resolve inside the turn that issued it: the commands are still in a client-side buffer, and on ANGLE they reach the GPU when the compositor takes a frame. A spin on QUERY_RESULT_AVAILABLE never terminates, because the spin is what is preventing the frame. That was measured here, not assumed: spinning for five seconds on an M4 through ANGLE's Metal backend returned `false` every time, on an extension the same context advertises. So the poll yields to the event loop between attempts, and a benchmark built on this awaits each sample.
  //
  // Returns milliseconds, or NaN for a sample the driver flagged disjoint.
  async measureAsync( fn ) {
    if ( typeof fn !== 'function' ) throw new Error( 'GpuTimer: measureAsync needs a function' )
    if ( this._open ) throw new Error( 'GpuTimer: measureAsync inside open region "' + this._open + '"' )
    if ( !this._ext ) return this._measureBarrier( fn )

    const q = this._gl.createQuery()
    this._gl.beginQuery( this._ext.TIME_ELAPSED_EXT, q )
    fn()
    this._gl.endQuery( this._ext.TIME_ELAPSED_EXT )
    this._gl.flush()

    const deadline = performance.now() + SYNC_POLL_TIMEOUT_MS
    while ( !this._gl.getQueryParameter( q, this._gl.QUERY_RESULT_AVAILABLE ) ) {
      if ( performance.now() > deadline ) {
        this._gl.deleteQuery( q )
        throw new Error( 'GpuTimer: timer query never became available after ' + SYNC_POLL_TIMEOUT_MS + ' ms -- the extension is present but not answering' )
      }
      await nextTurn()
    }
    const disjoint = this._gl.getParameter( this._ext.GPU_DISJOINT_EXT )
    const ns = this._gl.getQueryParameter( q, this._gl.QUERY_RESULT )
    this._gl.deleteQuery( q )
    // NaN rather than a number, so a disjoint sample cannot be averaged into anything by a caller that forgot to check. The caller's job is to drop it and take another.
    return disjoint ? NaN : ns / 1e6
  }

  // ---- The fallback measurement, and why it is not gl.finish().
  //
  // `finish()` is specified to block until every issued command has completed, and in a browser it does not: the WebGL implementation lives in another process, and Chrome's answer to finish() is to flush its command buffer and return. Measured on the M4 here, a finish()-bracketed 40-step raymarch over 230k pixels reported 0.00 ms, which is not a slow measurement, it is no measurement at all.
  //
  // `readPixels` on the default framebuffer is the barrier that actually holds. It cannot be answered without the pixels existing, so the call does not return until the GPU has produced them, and one pixel is enough -- the cost of the read itself is a fixed round trip that lands in every row equally and cancels out of every comparison between rows. That fixed cost is exactly why this is still labelled CPU-ESTIMATED: it is a real interval containing real GPU work plus a constant, not a GPU timestamp.
  _measureBarrier( fn ) {
    this._barrier()
    const t0 = performance.now()
    fn()
    this._barrier()
    return performance.now() - t0
  }

  _barrier() {
    const gl = this._gl
    // Whatever the caller left bound. A region that ends mid-way through a render-to-texture would otherwise read the wrong buffer, and on some drivers that is an INVALID_FRAMEBUFFER_OPERATION rather than a wrong number.
    gl.readPixels( 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._barrierPixel )
  }

  // -------------------------------------------------------------------------

  _push( name, ms ) {
    const arr = this._samples.get( name )
    arr.push( ms )
    if ( arr.length > this._window ) arr.shift()
  }

  // Milliseconds, or null when nothing has resolved yet. Null rather than 0: a region that has not answered must not read as a region that costs nothing, which is the exact failure this whole file exists to prevent.
  median( name ) {
    if ( !this._samples.has( name ) ) throw new Error( 'GpuTimer: no region "' + name + '"' )
    const arr = this._samples.get( name )
    if ( arr.length === 0 ) return null
    const s = arr.slice().sort( ( a, b ) => a - b )
    const mid = s.length >> 1
    return s.length % 2 ? s[ mid ] : ( s[ mid - 1 ] + s[ mid ] ) * 0.5
  }

  count( name ) {
    if ( !this._samples.has( name ) ) throw new Error( 'GpuTimer: no region "' + name + '"' )
    return this._samples.get( name ).length
  }

  get disjointDrops() {
    return this._disjointDrops
  }

  reset() {
    for ( const name of this._regions ) this._samples.set( name, [] )
    if ( this._ext ) for ( const p of this._pending ) this._gl.deleteQuery( p.query )
    this._pending.length = 0
    this._disjointDrops = 0
  }
}
