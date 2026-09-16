import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const logs: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-client-'));
  logs.length = 0;
  orchestrator = new Orchestrator(workspacePaths(root));
  await orchestrator.listen();
  // The daemon entry is never spawned here: a live lock already exists, so the
  // client attaches rather than starting one.
  client = new OrchestratorClient(root, join(root, 'never-spawned.js'), (m) => logs.push(m));
});

afterEach(() => {
  client.dispose();
  try { orchestrator?.shutdown(); } catch { /* already down is the happy case */ }
  rmSync(root, { recursive: true, force: true });
});

const lockFile = () => workspacePaths(root).lockFile;

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
    const next = new OrchestratorClient(root, join(root, 'never-spawned.js'), (m) => logs.push(m));
    await next.ensureConnected().catch(() => undefined);
    next.dispose();

    expect(logs.join('\n')).toMatch(/spawning orchestrator daemon/);
  });

  // The `false` return — the daemon was asked to leave and did not — is not
  // covered here. Faking a stubborn daemon means a lock naming a live pid at a
  // dead endpoint, and `connectWithRetry` spends ~6s backing off before the
  // request fails. The contract that matters is the caller's: `extension.ts`
  // refuses to reconnect on `false`, because reconnecting is precisely the old
  // bug — silently reattaching to the process it meant to replace.
});
