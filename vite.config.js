import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: true, port: 5173, proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } } },
  // Relative asset URLs so dist/ loads from a plain file tree or the desktop app:// scheme,
  // not just from a server root.
  base: './',
  build: { target: 'es2020', outDir: 'dist' },
});
