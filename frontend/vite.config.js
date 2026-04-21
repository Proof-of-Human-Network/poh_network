import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    proxy: {
      '/config': 'http://localhost:3000',
      '/checker': 'http://localhost:3000',
      '/methods': 'http://localhost:3000',
      '/evm': 'http://localhost:3000',
      '/rest': 'http://localhost:3000'
    }
  }
})
