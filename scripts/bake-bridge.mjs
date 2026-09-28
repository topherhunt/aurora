// Bake the standard stone bridge to public/gen-props/bridge-stone.glb (design/34-bridges.md).
//
//   node scripts/bake-bridge.mjs
import { writeFileSync } from 'node:fs'
import { bakeStoneBridge } from './lib/bridge-glb.mjs'

const OUT = new URL('../public/gen-props/bridge-stone.glb', import.meta.url)
const bytes = bakeStoneBridge()
writeFileSync(OUT, bytes)
console.log(`bridge-stone.glb: ${(bytes.byteLength / 1024).toFixed(1)} KB`)
