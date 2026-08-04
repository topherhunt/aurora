import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// WebXR requires a secure context. Three ways to get one on the Quest:
//
//   1. `npm run dev` -> https://<your-lan-ip>:5173 (self-signed; Quest Browser will
//      show a warning you must click through: "Advanced" -> "Proceed").
//   2. USB + developer mode, then `adb reverse tcp:5173 tcp:5173` and open
//      http://localhost:5173 on the headset. localhost counts as a secure context,
//      so there is no cert warning. Cleanest dev loop if you have a cable.
//   3. `npm run build` and deploy dist/ to GitHub Pages.
//
// `base` is relative so the built output works from any subpath, including
// topherhunt.com/games/aurora.
// Two pages: index.html is the game, spike.html is the §0 measurement harness,
// which still has unread numbers on it and stays deployed alongside.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spike: resolve(__dirname, 'spike.html'),
      },
    },
  },
})
