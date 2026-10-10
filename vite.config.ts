import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The app build: the editor (index.html), the standalone player page (player.html, also the
// iframe embed target) and an embed demo that behaves like a long article page (demo.html).
export default defineConfig({
  // relative base so dist/ works from any sub-path (GitHub Pages project sites, /tools/splat/, ...)
  base: './',
  server: { port: 5183, strictPort: true },
  preview: { port: 5184, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        player: resolve(__dirname, 'player.html'),
        demo: resolve(__dirname, 'demo.html'),
      },
    },
  },
})
