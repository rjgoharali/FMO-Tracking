import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = loadEnv(mode, root, '');
  const target = env.ADMIN_API_PROXY_TARGET || 'http://127.0.0.1:4000';
  return { plugins: [react(), tailwindcss()], envDir: root,
    // Explicit allowlist: no JWT, database or storage secrets enter the bundle.
    define: { __GOOGLE_MAPS_API_KEY__: JSON.stringify(env.GOOGLE_MAPS_API_KEY || ''), __GOOGLE_MAPS_MAP_ID__: JSON.stringify(env.GOOGLE_MAPS_MAP_ID || '') },
    server: { host: '127.0.0.1', port: 3000, strictPort: true, proxy: { '/api': { target, changeOrigin: false }, '/socket.io': { target, ws: true, changeOrigin: false } } },
    preview: { host: '127.0.0.1', port: 3000, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
  };
});
