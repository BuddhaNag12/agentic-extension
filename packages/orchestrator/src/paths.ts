import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Where a workspace's daemon state lives. The IPC endpoint is derived from the
 * workspace path so two windows on the same workspace attach to one daemon,
 * and two different workspaces never collide (§2.2).
 *
 * Two directories, deliberately:
 *
 * - `configDir` is `<root>/.agentflow` — committed inputs (`config.json`,
 *   `workflows/`, `policy.json`). **Read-only. Never created.** Nothing this
 *   tool does should add a directory to somebody's repository.
 * - `stateDir` is outside the repo and holds everything written: runs, the
 *   inbox cache, the lock and the daemon log. None of it is the repo's
 *   business, and all of it used to land in the working tree.
 */
export interface WorkspacePaths {
  root: string;
  /** Committed, in-repo, read-only. */
  configDir: string;
  /** Per-user, outside the repo, writable. */
  stateDir: string;
  lockFile: string;
  daemonLogFile: string;
  runsDir: string;
  ipcEndpoint: string;
}

/** The per-user root for all workspaces' state. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENTFLOW_STATE_DIR'];
  if (override) return override;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'AgentFlow');
  if (process.platform === 'win32') {
    return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'AgentFlow');
  }
  return join(env['XDG_STATE_HOME'] ?? join(home, '.local', 'state'), 'agentflow');
}

export function workspacePaths(root: string, env: NodeJS.ProcessEnv = process.env): WorkspacePaths {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  // The basename is in the directory name purely so a human browsing the
  // state root can tell which workspace is which; the hash is what makes it
  // unique.
  const stateDir = join(stateRoot(env), 'workspaces', `${basename(root) || 'workspace'}-${hash}`);
  return {
    root,
    configDir: join(root, '.agentflow'),
    stateDir,
    lockFile: join(stateDir, 'orchestrator.lock'),
    daemonLogFile: join(stateDir, 'orchestrator.log'),
    runsDir: join(stateDir, 'runs'),
    // Windows named pipes live in a reserved namespace; unix sockets go to a
    // temp dir because the 104-byte sun_path limit rules out deep repo paths.
    ipcEndpoint: process.platform === 'win32'
      ? `\\\\.\\pipe\\agentflow-${hash}`
      : join(tmpdir(), `agentflow-${hash}.sock`),
  };
}

/**
 * Move an earlier build's in-repo state out of the working tree.
 *
 * Only `runs` and `cache` are moved, and only when the destination does not
 * already exist: those hold history worth keeping. The lock and the log are
 * transient and are left where they are rather than being deleted, because a
 * daemon from the old build may still be holding them.
 *
 * Returns what moved, for the log. Never throws: failing to migrate is not a
 * reason to fail to start.
 */
export function migrateLegacyState(paths: WorkspacePaths): string[] {
  const moved: string[] = [];
  for (const name of ['runs', 'cache']) {
    const from = join(paths.configDir, name);
    const to = join(paths.stateDir, name);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(paths.stateDir, { recursive: true });
      renameSync(from, to);
      moved.push(name);
    } catch {
      // A cross-device rename or a permission problem; the run history stays
      // where it is and the new location starts empty.
    }
  }
  return moved;
}

export function runDir(paths: WorkspacePaths, runId: string): string {
  return join(paths.runsDir, runId);
}

export function runEventLogPath(paths: WorkspacePaths, runId: string): string {
  return join(runDir(paths, runId), 'events.jsonl');
}

export function runSnapshotPath(paths: WorkspacePaths, runId: string): string {
  return join(runDir(paths, runId), 'state.json');
}
