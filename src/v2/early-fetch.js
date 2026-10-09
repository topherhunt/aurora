// index.html starts the boot's data fetches before the code has downloaded. A page without that script (a probe, a gate) fetches here as usual.
export function earlyFetch(url, init) {
  const early = globalThis.window?.earlyFetches?.[url]
  if (!early) return fetch(url, init)
  delete window.earlyFetches[url]
  return early
}
