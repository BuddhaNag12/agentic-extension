import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Daemon tests drive a real socket and a scripted run end to end.
    testTimeout: 20_000,
  },
});
