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
    // 强制 IPv4:Windows 上 vite 默认只绑 [::1],Electron 解析 localhost 走 127.0.0.1 会连接被拒
    server: {
      host: '127.0.0.1'
    },
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
