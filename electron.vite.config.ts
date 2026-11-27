import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react()]
  }
})
