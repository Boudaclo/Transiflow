import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { pwaPlugin } from './scripts/pwa-plugin';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), pwaPlugin()],
  // Les paquets du monorepo sont consommés depuis leurs sources TypeScript : un seul format de module, pas d'étape de build préalable.
  resolve: {
    alias: {
      '@transport/shared': src('../../packages/shared/src/index.ts'),
      '@transport/offline': src('../../packages/offline/src/index.ts'),
    },
  },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { target: 'es2020', chunkSizeWarningLimit: 300 },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
