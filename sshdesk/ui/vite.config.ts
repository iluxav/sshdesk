import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Tauri serves the bundle from a custom protocol, not a web root.
  // Absolute /assets/... paths do not resolve there; relative ones do.
  base: './',
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext', emptyOutDir: true },
})
