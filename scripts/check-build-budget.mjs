// Node-side gates for the shared tile-build budget (src/v2/build-budget.js).
//
//   node scripts/check-build-budget.mjs

import { BuildScheduler } from '../src/v2/build-budget.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const layer = () => {
  const l = { tile: 10, queue: [{ tx: 0, tz: 0 }], grown: 0 }
  l._growTile = () => { l.grown++ }
  return l
}

{
  // A room swap: main.js's disposeRoom clears the scheduler, and buildRoom adds the next room's layers under the same names.
  const s = new BuildScheduler(4)
  const spent = s.spent
  const old = layer()
  s.add(old, undefined, { name: 'trees' })
  let threw = null
  try { s.add(layer(), undefined, { name: 'trees' }) } catch (e) { threw = e }
  check(threw !== null, 'a second source under a name already taken throws')
  s.clear()
  const next = layer()
  threw = null
  try { s.add(next, undefined, { name: 'trees' }) } catch (e) { threw = e }
  check(threw === null, 'after clear, the next room adds its layers under the same names', threw?.message ?? '')
  old.queue.push({ tx: 0, tz: 0 })
  s.run(0, 0)
  check(old.grown === 0 && next.grown === 1, 'a cleared layer is never grown again; the new one is', `old ${old.grown}, new ${next.grown}`)
  check(s.spent === spent && Object.keys(spent).join() === 'trees', 'clear keeps the one spent object the trace windows hold', Object.keys(spent).join())
}

console.log(`\n${failures === 0 ? 'all build-budget checks passed' : `${failures} build-budget check(s) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
