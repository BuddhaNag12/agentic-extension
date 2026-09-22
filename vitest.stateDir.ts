import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fixed rather than random, so config and setup agree without passing it. */
export const TEST_STATE_DIR = join(tmpdir(), 'agentflow-test-state');
