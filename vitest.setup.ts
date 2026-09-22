import { mkdirSync, rmSync } from 'node:fs';
import { TEST_STATE_DIR } from './vitest.stateDir.js';

/**
 * Keep the suite out of the developer's real state directory.
 *
 * `workspacePaths()` resolves `stateDir` under `stateRoot()`, which on macOS
 * is `~/Library/Application Support/AgentFlow`. A test that builds paths from
 * a temp workspace still lands there, and a test that spawns a real daemon
 * writes there — so running the suite left a directory per test case in the
 * developer's application data, two hundred of them before anyone looked.
 *
 * The override itself is set via `test.env` in the config, so that it reaches
 * the worker processes and anything they spawn. This only manages the
 * directory's life.
 */
export function setup(): void {
  mkdirSync(TEST_STATE_DIR, { recursive: true });
}

export function teardown(): void {
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
}
