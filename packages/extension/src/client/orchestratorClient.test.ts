import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator, readLiveLock, workspacePaths } from '@agentflow/orchestrator';
import { OrchestratorClient } from './orchestratorClient.js';

/**
 * "Restart Orchestrator" did not restart the orchestrator.
 *
 * `dispose()` drops this end of the socket, but the daemon is detached and its
 * lockfile still names a live pid — so the next `ensureConnected()` reattached
 * to the very process the command was meant to replace. Nothing failed, which
 * is why it survived: the symptom was new code appearing to have no effect
 * after reinstalling the extension.
 */

process.env['AGENTFLOW_SIMULATE'] = '1';

let root: string;
let orchestrator: Orchestrator | undefined;
let client: OrchestratorClient;
let daemonEntry: string;
const logs: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-client-'));
  logs.length = 0;
  // A real file, because the build check reads its mtime. It is never
  // actually spawned: a live lock exists, so the client attaches instead.
  daemonEntry = join(root, 'daemon-entry.js');
  writeFileSync(daemonEntry, '// never actually spawned in these tests\n');

  orchestrator = new Orchestrator(workspacePaths(root));
  await orchestrator.listen();
  // The in-process daemon records vitest's own argv[1] as its build. Point the
  // lock at the entry these tests use, so "same build" is the default state
  // and a mismatch is something a test opts into.
  matchBuild();

  client = new OrchestratorClient(root, daemonEntry, (m) => logs.push(m));
});

afterEach(() => {
  client.dispose();
  try { orchestrator?.shutdown(); } catch { /* already down is the happy case */ }
  rmSync(root, { recursive: true, force: true });
});

const lockFile = () => workspacePaths(root).lockFile;

/** Rewrite the lock so it claims the daemon started from `daemonEntry`. */
function matchBuild(): void {
  const lock = readLiveLock(lockFile());
  if (!lock) return;
  writeFileSync(lockFile(), JSON.stringify({ ...lock, entryMtimeMs: statSync(daemonEntry).mtimeMs }));
}

describe('shutting the daemon down', () => {
  it('attaches to the running daemon rather than starting another', async () => {
    await client.ensureConnected();
    expect(client.connected).toBe(true);
    // If it had spawned, it would have tried `never-spawned.js` and failed.
    expect(logs.join('\n')).not.toMatch(/spawning/);
  });

  it('leaves the daemon alive on dispose — a window reload must not kill a run', async () => {
    await client.ensureConnected();
    client.dispose();

    expect(readLiveLock(lockFile())).toBeDefined();
  });

  it('actually stops the daemon and clears its lock', async () => {
    await client.ensureConnected();

    const stopped = await client.shutdownDaemon();
    expect(stopped).toBe(true);
    // The lock is what the next client reads to decide whether to attach.
    expect(readLiveLock(lockFile())).toBeUndefined();
    expect(existsSync(lockFile())).toBe(false);
    orchestrator = undefined;
  });

  it('lets the next client start a fresh daemon rather than reattaching', async () => {
    await client.ensureConnected();
    await client.shutdownDaemon();
    orchestrator = undefined;

    // With no live lock, a new client spawns. It is pointed at a path that does
    // not exist, so the *attempt* is what this asserts — the old behaviour
    // would have reattached and never tried.
    const next = new OrchestratorClient(root, daemonEntry, (m) => logs.push(m));
    await next.ensureConnected().catch(() => undefined);
    next.dispose();

    expect(logs.join('\n')).toMatch(/spawning orchestrator daemon/);
  });

  it('replaces a daemon started from a different build', async () => {
    // The bug: an extension upgraded underneath a running daemon kept talking
    // to the old one, so every method the new version added went to a process
    // that had never heard of it. Nothing errored — it just did nothing.
    await client.ensureConnected();
    const firstPid = readLiveLock(lockFile())!.pid;

    // Rewrite the lock as if the daemon had started from an older bundle.
    const lock = readLiveLock(lockFile())!;
    writeFileSync(lockFile(), JSON.stringify({ ...lock, entryMtimeMs: 1 }));
    client.dispose();

    const next = new OrchestratorClient(root, daemonEntry, (m) => logs.push(m));
    await next.ensureConnected().catch(() => undefined);
    next.dispose();

    expect(logs.join('\n')).toMatch(/older build; restarting/);
    // It shut the old one down rather than attaching to it.
    expect(readLiveLock(lockFile())?.pid).not.toBe(firstPid);
    orchestrator = undefined;
  });

  it('treats a lock with no build id as stale', async () => {
    // Every daemon from this build forward records one, so its absence means
    // the daemon predates the check — which is exactly the upgrade that needs
    // it. Treating missing as fine would make the fix a no-op on first use.
    await client.ensureConnected();
    const firstPid = readLiveLock(lockFile())!.pid;

    const { entryMtimeMs: _gone, ...older } = readLiveLock(lockFile())!;
    writeFileSync(lockFile(), JSON.stringify(older));
    client.dispose();

    const next = new OrchestratorClient(root, daemonEntry, (m) => logs.push(m));
    await next.ensureConnected().catch(() => undefined);
    next.dispose();

    expect(logs.join('\n')).toMatch(/older build; restarting/);
    expect(readLiveLock(lockFile())?.pid).not.toBe(firstPid);
    orchestrator = undefined;
  });

  it('attaches when the build matches, and does not restart for nothing', async () => {
    await client.ensureConnected();
    const pid = readLiveLock(lockFile())!.pid;
    client.dispose();

    const next = new OrchestratorClient(root, daemonEntry, (m) => logs.push(m));
    await next.ensureConnected();
    next.dispose();

    expect(logs.join('\n')).not.toMatch(/older build/);
    expect(readLiveLock(lockFile())?.pid).toBe(pid);
  });

  // The `false` return — the daemon was asked to leave and did not — is not
  // covered here. Faking a stubborn daemon means a lock naming a live pid at a
  // dead endpoint, and `connectWithRetry` spends ~6s backing off before the
  // request fails. The contract that matters is the caller's: `extension.ts`
  // refuses to reconnect on `false`, because reconnecting is precisely the old
  // bug — silently reattaching to the process it meant to replace.
});
