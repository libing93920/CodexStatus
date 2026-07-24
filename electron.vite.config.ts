import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      minify: 'esbuild',
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    build: {
      minify: 'esbuild'
    }
  },
  renderer: {
    build: {
      minify: 'esbuild',
      cssMinify: true,
      target: 'es2022'
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
