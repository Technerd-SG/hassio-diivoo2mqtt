import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:8099',
        // target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})