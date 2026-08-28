// ---------------------------------------------------------------------------
// Thin client for OpenRouter's image-generation endpoint (POST /api/v1/images).
// sheet-prompt.mjs builds the prompts this sends; gen-sheet.html's dev-server
// endpoint (vite.config.js) is the only caller in this codebase, so every
// call here is triggered by an explicit button click in that bench -- never
// invoke this in a loop or on a timer, per the project's spend-gate rule.
//
// Model: FLUX.2 Klein 4B (black-forest-labs/flux.2-klein-4b), OpenRouter's
// cheapest/fastest image model as of writing. Pricing (openrouter.ai/black-
// forest-labs/flux.2-klein-4b): $0.014 for the first megapixel, $0.001 per
// megapixel after -- a "1K" (~1MP) generation is ~$0.014-0.015.
// ---------------------------------------------------------------------------

const API_URL = 'https://openrouter.ai/api/v1/images'
const DEFAULT_MODEL = 'black-forest-labs/flux.2-klein-4b'

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
