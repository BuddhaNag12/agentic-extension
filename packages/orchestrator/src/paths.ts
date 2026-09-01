import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a workspace's daemon state lives. The IPC endpoint is derived from the
 * workspace path so two windows on the same workspace attach to one daemon,
 * and two different workspaces never collide (§2.2).
 */
export interface WorkspacePaths {
  root: string;
  agentflowDir: string;
  lockFile: string;
  runsDir: string;
  ipcEndpoint: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const agentflowDir = join(root, '.agentflow');
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return {
    root,
    agentflowDir,
    lockFile: join(agentflowDir, 'orchestrator.lock'),
    runsDir: join(agentflowDir, 'runs'),
    // Windows named pipes live in a reserved namespace; unix sockets go to a
    // temp dir because the 104-byte sun_path limit rules out deep repo paths.
    ipcEndpoint: process.platform === 'win32'
      ? `\\\\.\\pipe\\agentflow-${hash}`
      : join(tmpdir(), `agentflow-${hash}.sock`),
  };
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
