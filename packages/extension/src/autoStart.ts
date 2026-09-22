import { existsSync } from 'node:fs';
import type { WorkspacePaths } from '@agentflow/orchestrator';

/**
 * Whether activation should connect, or wait to be asked.
 *
 * The extension activates on `onStartupFinished`, which fires in every window
 * in every project. Connecting unconditionally meant a daemon process and a
 * state directory per repository, for repositories that had never heard of
 * the tool.
 *
 * Prior use is the opt-in, and it has two shapes since state moved out of the
 * working tree: a state directory for a workspace that has run something, and
 * an in-repo `.agentflow/` for one that commits workflows or a repo registry
 * without having run anything yet.
 *
 * Nothing is lost by waiting — every command connects lazily, so the first one
 * run in a fresh repository starts the daemon anyway.
 */
export function shouldAutoStart(paths: WorkspacePaths, enabled: boolean): boolean {
  if (!enabled) return false;
  return existsSync(paths.stateDir) || existsSync(paths.configDir);
}
