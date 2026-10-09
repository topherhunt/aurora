// Creature models and the sound engine load on first need instead of at boot. A
// wanted load waits for openLoads (main.js, once the first room is playable) and
// runs one at a time, so no GLB fetch or parse lands inside the build or stacks on another's.

let open = false
let running = false
const queue = []

export function openLoads() {
  open = true
  pump()
}

/**
 * `load` deferred. `want()` queues it behind the boot; `need()` starts it now and
 * returns `ready`. AWAITING `ready` NEVER STARTS THE LOAD: a caller that cannot
 * go on without the asset calls `need()`, or it waits forever and nothing says so.
 */
export function lazyLoad(load) {
  let started = false
  let queued = false
  let settle
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const run = () => {
    if (started) return null
    started = true
    const p = load()
    p.then(settle.resolve, settle.reject)
    return p
  }
  return {
    ready,
    want() {
      if (started || queued) return
      queued = true
      queue.push(run)
      pump()
    },
    need() {
      run()
      return ready
    },
  }
}

async function pump() {
  if (!open || running) return
  running = true
  // `ready` carries a failure to its own listeners; this only waits it out, so a rejection here must not be caught on `ready` itself.
  while (queue.length) await queue.shift()()?.then(() => {}, () => {})
  running = false
}
