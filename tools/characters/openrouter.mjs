// ---------------------------------------------------------------------------
// Thin client for OpenRouter's image-generation endpoint (POST /api/v1/images).
// Every caller is a dev-server endpoint behind a button in a bench (sheets,
// fish, creatures, trees), so every call here is one explicit click -- never
// invoke this in a loop or on a timer, per the project's spend-gate rule.
//
// Default model: FLUX.2 Klein 4B (black-forest-labs/flux.2-klein-4b), the
// cheapest of the offered models. Pricing (openrouter.ai/black-forest-labs/
// flux.2-klein-4b): $0.014 for the first megapixel, $0.001 per megapixel after
// -- a "1K" (~1MP) generation is ~$0.014-0.015. A bench that wants a better
// picture passes a `model` from IMAGE_MODELS below; /gen-tree-v9 does, because
// FLUX draws a symmetrical specimen tree where Nano Banana photographs a real
// one (§28).
// ---------------------------------------------------------------------------

const API_URL = 'https://openrouter.ai/api/v1/images'
const DEFAULT_MODEL = 'black-forest-labs/flux.2-klein-4b'

/**
 * The models a bench is allowed to offer, cheapest first. A model id arriving
 * from a browser must be checked against this list before it reaches a paid
 * endpoint -- the dev server binds to the LAN, and an unchecked id is someone
 * else choosing what your account buys.
 *
 * `usd` is per image at ~1MP and is an ESTIMATE for printing on a button; the
 * real figure comes back in the response's usage.cost and is what gets recorded.
 * Google bills these per output token (~1290 tokens an image), so the estimate
 * is that arithmetic, not a quoted price.
 */
export const IMAGE_MODELS = [
  { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 Klein 4B', usd: 0.015 },
  { id: 'google/gemini-2.5-flash-image', label: 'Nano Banana', usd: 0.04 },
  { id: 'google/gemini-3.1-flash-image', label: 'Nano Banana 2', usd: 0.08 },
  { id: 'google/gemini-3-pro-image', label: 'Nano Banana Pro', usd: 0.15 },
]

/** Throws unless `id` is one of IMAGE_MODELS; returns the entry. */
export function requireImageModel(id) {
  const model = IMAGE_MODELS.find((m) => m.id === id)
  if (!model) throw new Error(`"${id}" is not an offered image model -- one of ${IMAGE_MODELS.map((m) => m.id).join(', ')}`)
  return model
}

/**
 * Generates one image. `referenceImages`, if given, is an array of PNG
 * Buffers attached as image-edit references (OpenRouter's `input_references`
 * field) -- used to keep the side/back views the same character as a
 * previously generated front view.
 *
 * Returns { buffer, mediaType, cost } -- cost in USD as reported by
 * OpenRouter's usage field (0 if a provider doesn't report one). Throws on
 * any non-2xx response or a response with no image data; never bills silently.
 */
export async function generateImage({
  prompt,
  model = DEFAULT_MODEL,
  aspectRatio = '9:16',
  resolution = '1K',
  seed,
  referenceImages,
} = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set -- add it to .env (gitignored) before generating images')
  if (!prompt) throw new Error('generateImage requires a prompt')

  const body = { model, prompt, n: 1, aspect_ratio: aspectRatio, resolution, output_format: 'png' }
  if (seed !== undefined) body.seed = seed
  if (referenceImages?.length) {
    body.input_references = referenceImages.map((buf) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${buf.toString('base64')}` },
    }))
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`OpenRouter returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`) }
  if (!res.ok) throw new Error(`OpenRouter image generation failed (status ${res.status}): ${json.error?.message || text.slice(0, 300)}`)

  const image = json.data?.[0]
  if (!image?.b64_json) throw new Error(`OpenRouter response had no image data: ${text.slice(0, 300)}`)

  return {
    buffer: Buffer.from(image.b64_json, 'base64'),
    mediaType: image.media_type || 'image/png',
    cost: json.usage?.cost ?? 0,
  }
}
