import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.POLYPHONY_API ?? 'http://127.0.0.1:4317';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
