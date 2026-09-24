import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Database tests. Separate from the unit suite because they need a live
 * PostgreSQL development database (npm run db:reset first).
 *
 * Single-threaded: the suites share one database, and running them in parallel
 * would make failures non-deterministic.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/test/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
