import { defineConfig } from 'vitest/config';
import { TEST_STATE_DIR } from './vitest.stateDir.js';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Without this the suite writes a directory per test case into the
    // developer's real application data. See vitest.setup.ts.
    env: { AGENTFLOW_STATE_DIR: TEST_STATE_DIR },
    globalSetup: ['./vitest.setup.ts'],
    // Daemon tests drive a real socket and a scripted run end to end.
    testTimeout: 20_000,
  },
});
