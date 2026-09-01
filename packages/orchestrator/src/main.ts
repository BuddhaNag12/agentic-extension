#!/usr/bin/env node
import { Orchestrator } from './daemon.js';
import { readLiveLock } from './lock.js';
import { workspacePaths } from './paths.js';

/**
 * Daemon entry point. Spawned lazily by the extension on first use and left
 * running across window reloads (§2.2).
 *
 *   agentflow-orchestrator --workspace /path/to/repo
 */
async function main(): Promise<void> {
  const idx = process.argv.indexOf('--workspace');
  const root = idx >= 0 ? process.argv[idx + 1] : process.cwd();
  if (!root) {
    process.stderr.write('usage: agentflow-orchestrator --workspace <path>\n');
    process.exit(2);
  }

  const paths = workspacePaths(root);

  // Losing a spawn race is normal: two windows opening at once both try. The
  // loser exits quietly and its client attaches to the winner's endpoint.
  const existing = readLiveLock(paths.lockFile);
  if (existing) {
    process.stdout.write(`${JSON.stringify({ status: 'already-running', ...existing })}\n`);
    process.exit(0);
  }

  const orchestrator = new Orchestrator(paths);
  const endpoint = await orchestrator.listen();
  // The extension reads this line to learn where to connect.
  process.stdout.write(`${JSON.stringify({ status: 'listening', endpoint, pid: process.pid })}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      orchestrator.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[agentflow] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
