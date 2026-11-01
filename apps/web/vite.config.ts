import { defineConfig } from 'vite';
export default defineConfig({
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: ['dev-web'],
    watch: { usePolling: process.env.MIMIR_WATCH_POLLING === 'true', interval: 300 },
    proxy: Object.fromEntries(['/api', '/health', '/ready'].map(path => [path, { target: 'http://api:3000' }]))
  }
});
