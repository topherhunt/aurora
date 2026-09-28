// The shipped stone bridge (design/34-bridges.md): one baked mesh at three LODs, stretched and squashed per crossing by its instance transform. Baked by scripts/bake-bridge.mjs from bridge.js's defaults. Its standard size and how to place it: design/34-bridges.md §The shipped mesh.
import { gltfLoader } from '../v2/render/critters.js'

export const STONE_BRIDGE_GLB = 'gen-props/bridge-stone.glb'

/**
 * { lods: [geometry x 3], meta } from a loaded glTF. The geometries are in the shared prop material's layout; `meta` is the bake's extras: the bridge's extent (xa, xb, halfWidth), its bank and crest heights, the deck profile, the post-top sockets and the flame lights, all in the unscaled frame.
 */
export function parseStoneBridge(gltf) {
  const lods = ['lod0', 'lod1', 'lod2'].map((name) => {
    const node = gltf.scene.getObjectByName(name)
    if (!node?.isMesh) throw new Error(`stone bridge: the glb has no mesh ${name}`)
    const g = node.geometry
    // glTF lowercases the custom attributes' names.
    for (const [from, to] of [['_uvproj', 'uvProj'], ['_texlayer', 'texLayer']]) {
      if (!g.getAttribute(from)) throw new Error(`stone bridge: ${name} has no ${from}`)
      g.setAttribute(to, g.getAttribute(from))
      g.deleteAttribute(from)
    }
    return g
  })
  const meta = gltf.scene.userData
  if (!Array.isArray(meta.deck)) throw new Error('stone bridge: the glb carries no deck profile')
  return { lods, meta }
}

export async function loadStoneBridge(url = STONE_BRIDGE_GLB) {
  const loader = await gltfLoader()
  return parseStoneBridge(await loader.loadAsync(url))
}

/** The walkable surface at (x, z) in the bridge's unscaled frame; divide a world point by the instance's scale first and multiply the height back. */
export function stoneBridgeDeckAt(meta, x, z) {
  const { xa, xb, deck, inner, camber } = meta
  const t = Math.min(1, Math.max(0, (x - xa) / (xb - xa))) * (deck.length - 1)
  const k = Math.min(deck.length - 2, Math.floor(t))
  const y = deck[k] + (deck[k + 1] - deck[k]) * (t - k)
  return y + (Math.abs(z) < inner ? camber * (1 - (z / inner) ** 2) : 0)
}
