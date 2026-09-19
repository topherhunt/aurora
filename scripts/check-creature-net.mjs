// Node-side gate for the room's creature traffic (src/v2/creature-net.js).
//
//   node scripts/check-creature-net.mjs
//
// Against a stand-in Netplay: an anchor a layer owes goes out once, a lured
// set a swarm layer owes goes out once, neither is queued when the relay is
// shut; a block from the relay is routed to the layer wearing the key's first
// word, an anchor with apply and a set with applyLured, this client's own
// echoes dropped, a prefix no layer owns said once and not thrown on; a
// layer with neither pair of verbs is refused.

import { CreatureNet } from '../src/v2/creature-net.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const netplay = {
  id: 'me', open: true, creatures: [], anchors: [], lured: [],
  sendAnchor(a) { if (!this.open) return false; this.anchors.push(a); return true },
  sendLured(s) { if (!this.open) return false; this.lured.push(s); return true },
}
const clock = { seconds: 500 }
const animals = { owed: [], got: [], pending(into) { into.push(...this.owed); this.owed.length = 0 }, apply(a, now) { this.got.push([a, now]) } }
const swarm = { owed: [], got: [], pendingLured(into) { into.push(...this.owed); this.owed.length = 0 }, applyLured(s, now) { this.got.push([s, now]) } }
const net = new CreatureNet(netplay, clock, [{ layer: animals, prefixes: ['st', 'fx'] }])
net.add(swarm, ['fg'])
let refused = false
try { net.add({ update() {} }, ['zz']) } catch { refused = true }
check(refused, 'a layer with neither pending/apply nor pendingLured/applyLured is refused')
let twice = false
try { net.add(swarm, ['st']) } catch { twice = true }
check(twice, 'a prefix cannot be claimed twice')

// Out: each owed once.
const anchor = ['st:1,2:0', 500, 0, 0, 0, 0, 0, 0, null]
animals.owed.push(anchor)
swarm.owed.push(['fg:0,0', 'fg', null, [1, 4]])
net.update()
net.update()
check(netplay.anchors.length === 1 && netplay.anchors[0] === anchor && net.stats.sent === 1, 'an anchor a layer owes goes to the relay once', `${netplay.anchors.length} sent`)
check(netplay.lured.length === 1 && netplay.lured[0][0] === 'fg:0,0' && net.stats.luredSent === 1, 'a lured set a swarm layer owes goes to the relay once', `${netplay.lured.length} sent`)
netplay.open = false
animals.owed.push(anchor)
swarm.owed.push(['fg:0,0', 'fg', null, []])
net.update()
netplay.open = true
net.update()
check(netplay.anchors.length === 1 && netplay.lured.length === 1 && net.stats.dropped === 2, 'with the relay shut what is owed is dropped, not queued', `${net.stats.dropped} dropped`)

// In: routed by the key's first word, own echoes dropped, a strange prefix said once.
const warns = []
const warn = console.warn
console.warn = (m) => warns.push(m)
netplay.creatures.push({
  anchors: [['st:1,2:0', 1, 2, 3, 4, 5, 6, 7, 'peer'], ['fx:3,3:1', 1, 2, 3, 4, 5, 6, 7, 'me'], ['zz:9', 1, 2, 3, 4, 5, 6, 7, 'peer'], 'junk'],
  lured: [['fg:0,0', 'fg', 'peer', [2]], ['fg:0,1', 'fg', 'me', [3]], ['zz:1', 'zz', 'peer', []], ['st:1,2:0', 'st', 'peer', [0]]],
})
netplay.creatures.push({ anchors: [['fx:3,3:1', 1, 2, 3, 4, 5, 6, 7, 'other']] })
clock.seconds = 501
net.update()
console.warn = warn
check(animals.got.length === 2 && animals.got[0][0][0] === 'st:1,2:0' && animals.got[1][0][0] === 'fx:3,3:1' && animals.got.every(([, now]) => now === 501), 'anchors reach the layer wearing their prefix, at the room\'s clock, this client\'s own echo dropped', `${animals.got.length} applied`)
check(swarm.got.length === 1 && swarm.got[0][0][0] === 'fg:0,0' && swarm.got[0][0][3][0] === 2, 'a lured set reaches the swarm layer wearing its prefix, this client\'s own dropped', `${swarm.got.length} applied`)
check(net.stats.heard === 2 && net.stats.luredHeard === 1, 'the stats count what landed', JSON.stringify(net.stats))
check(warns.length === 1 && warns[0].includes('zz'), 'a prefix no layer owns is said once, over the anchor and the set both', JSON.stringify(warns))
check(netplay.creatures.length === 0, 'the blocks are consumed')
// A set for a layer that takes anchors only, or an anchor for one that takes sets only, is dropped without a throw.
netplay.creatures.push({ anchors: [['fg:0,0:1', 1, 2, 3, 4, 5, 6, 7, 'peer']], lured: [['st:1,2:0', 'st', 'peer', [0]]] })
let threw = false
try { net.update() } catch { threw = true }
check(!threw && animals.got.length === 2 && swarm.got.length === 1, 'an anchor for a swarm layer, or a set for an animal layer, is dropped quietly')

net.dispose()
check(net.layers.length === 0 && net.byPrefix.size === 0 && netplay.creatures.length === 0, 'dispose forgets the layers and what came in')

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
