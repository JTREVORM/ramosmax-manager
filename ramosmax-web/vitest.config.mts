import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Database tests need a live PostgreSQL development database and run
    // under vitest.db.config.mts (npm run test:db). Keeping them out means
    // `npm test` stays fast and needs no services.
    exclude: ['src/test/db/**'],
  },
});
