import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repo, 'INDEXER_');
  const target = process.env.INDEXER_URL || env.INDEXER_URL || 'http://localhost:4030';
  const proxy = { '/api': { target, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ''), timeout: 0, proxyTimeout: 0 } };
  return { root, plugins: [react()], server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy }, preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy }, build: { outDir: 'dist', sourcemap: false } };
});
