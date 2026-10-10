import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Usa o código-fonte do pacote compartilhado (sem etapa de build no desenvolvimento).
    alias: { '@mobigo/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/media': { target: api, changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900, // MapLibre (~800 kB) fica em chunk próprio, cacheado entre versões
    rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'] } } },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
