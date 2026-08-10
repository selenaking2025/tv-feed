import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      sourcemap: true
    }
  },
  preload: {
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    build: {
      sourcemap: true,
      minify: 'esbuild'
    }
  }
})
