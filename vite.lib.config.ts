import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// The library build: one self-contained ES module with the player and the engine code it
// uses. This is the file another site imports (dynamically) to embed a splat.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist-lib',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    lib: {
      entry: resolve(__dirname, 'src/player/index.ts'),
      formats: ['es'],
      fileName: () => 'splat-player.js',
    },
  },
  plugins: [
    {
      name: 'emit-types',
      closeBundle() {
        execSync('npx tsc -p tsconfig.lib.json', { stdio: 'inherit' })
      },
    },
  ],
})
