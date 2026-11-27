// Browser-only build of the renderer (mock API) for UI development and screenshots: `npm run dev:web`.
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: { port: 5174, strictPort: false },
  build: { outDir: resolve('out/web'), emptyOutDir: true }
})
