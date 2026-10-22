/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { landingPlugin } from './build/landing';

// Local loopback only: the web dev server proxies the API so cookies stay same-origin.
const apiProxy = {
  '/api': { target: 'http://127.0.0.1:4310' },
};

export default defineConfig({
  plugins: [landingPlugin(), react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { app: fileURLToPath(new URL('./index.html', import.meta.url)), landing: fileURLToPath(new URL('./landing.html', import.meta.url)), docs: fileURLToPath(new URL('./docs.html', import.meta.url)) } },
  },
  test: {
    // Locale resources are discovered from directory contents with import.meta.glob.
    // Persistent transform caches can retain an old inventory after JSON files are added.
    fsModuleCache: false,
    // Browser/jsdom tests share the local machine with browser acceptance runs; two workers
    // keep local resource use bounded and reproducible.
    maxWorkers: 2,
    environment: 'jsdom',
    // jsdom functional budget only; not a latency or performance acceptance threshold.
    testTimeout: 15_000,
    setupFiles: ['./src/test/setup.ts'],
  },
});
