import { defineConfig } from 'vitest/config';

// Single fork: one pg.Pool + one shared testcontainers postgres for the whole
// run. Without singleFork, every test file would re-init the migrations and
// race on the container.
export default defineConfig({
  test: {
    globalSetup: ['tests/helpers/global-setup.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
