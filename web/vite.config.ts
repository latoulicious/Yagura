import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: proxy /api (incl. SSE) to the axum backend. Prod: dist/ is embedded.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  // emptyOutDir: false keeps the committed dist/.gitkeep so a fresh clone has the
  // folder rust-embed needs before the first build. CI clones clean, so no stale assets.
  build: { outDir: 'dist', emptyOutDir: false },
})
