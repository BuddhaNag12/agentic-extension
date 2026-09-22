import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMessageConnection, SocketMessageReader, SocketMessageWriter,
} from 'vscode-jsonrpc/node.js';
import { Methods, PROTOCOL_VERSION, type HandshakeResult } from '@agentflow/protocol';
import { setLogFile } from './daemon.js';
import { workspacePaths } from './paths.js';

/**
 * The daemon is detached so that reloading a window cannot kill a run (§2.2).
 * That guarantee was false: its log went to a stderr pipe owned by the
 * extension host, and when the host exited the next log line raised a fatal
 * EPIPE. These tests spawn the real entry point, because the bug lived
 * entirely in how the process was wired to its parent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const entry = join(here, '..', 'dist', 'main.js');

let child: ChildProcess | undefined;
let root: string;

beforeAll(() => {
  if (!existsSync(entry)) {
    execFileSync('npx', ['tsc', '-b', 'packages/orchestrator'], { cwd: repoRoot, stdio: 'pipe' });
  }
}, 120_000);

afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((res) => child!.once('exit', () => res()));
    child.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

function startDaemon(
  workspace: string,
  env: Record<string, string> = {},
): Promise<{ proc: ChildProcess; endpoint: string }> {
  const proc = spawn(process.execPath, [entry, '--workspace', workspace], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // An idle daemon must not outlive the test that spawned it.
    env: { ...process.env, AGENTFLOW_IDLE_SHUTDOWN_MS: '600000', ...env },
  });
  proc.unref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon never reported an endpoint')), 15_000);
    proc.stdout!.on('data', (c: Buffer) => {
      for (const line of c.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { status: string; endpoint?: string };
        if (msg.status === 'listening' && msg.endpoint) {
          clearTimeout(timer);
          resolve({ proc, endpoint: msg.endpoint });
        }
      }
    });
    proc.on('error', reject);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, hint: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} did not complete in ${ms}ms — ${hint}`)), ms)),
  ]);
}

async function handshake(endpoint: string, workspace: string): Promise<HandshakeResult> {
  const socket = connect(endpoint);
  await new Promise<void>((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });
  const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
  conn.listen();
  try {
    return await withTimeout(
      conn.sendRequest<HandshakeResult>(Methods.handshake, {
        protocolVersion: PROTOCOL_VERSION, workspaceRoot: workspace, clientId: 'survival-test',
      }),
      5_000, 'handshake', 'the daemon is probably dead',
    );
  } finally {
    conn.dispose();
    socket.destroy();
  }
}

describe('surviving the extension host (§2.2)', () => {
  it('keeps serving after the parent closes the stdio pipes it was spawned with', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-survive-'));
    const started = await startDaemon(root);
    child = started.proc;

    // What a window reload does to us: the host exits, and the read ends of
    // our stdout and stderr go away.
    started.proc.stdout!.destroy();
    started.proc.stderr!.destroy();

    // Attaching makes the daemon log, which is what used to be fatal.
    const first = await handshake(started.endpoint, root);
    expect(first.pid).toBe(started.proc.pid);

    // Still alive for the next window, which is the whole point.
    const second = await handshake(started.endpoint, root);
    expect(second.pid).toBe(started.proc.pid);
    expect(started.proc.exitCode).toBeNull();
  }, 30_000);

  it('writes its log to the workspace rather than to the parent pipe', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-survive-'));
    const started = await startDaemon(root);
    child = started.proc;
    started.proc.stderr!.destroy();

    await handshake(started.endpoint, root);

    const logPath = workspacePaths(root).daemonLogFile;
    expect(readFileSync(logPath, 'utf8')).toContain('client attached');
  }, 30_000);
});

describe('log rotation', () => {
  it('keeps one generation back once the log passes its cap', () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-rotate-'));
    const logPath = join(root, '.agentflow', 'orchestrator.log');
    setLogFile(logPath);
    writeFileSync(logPath, 'x'.repeat(2_000_001));

    setLogFile(logPath);
    expect(statSync(`${logPath}.old`).size).toBe(2_000_001);
  });

  it('leaves a log that is still under the cap alone', () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-rotate-'));
    const logPath = join(root, '.agentflow', 'orchestrator.log');
    setLogFile(logPath);
    writeFileSync(logPath, 'small');

    setLogFile(logPath);
    expect(readFileSync(logPath, 'utf8')).toBe('small');
    expect(() => statSync(`${logPath}.old`)).toThrow();
  });
});

describe('idle shutdown', () => {
  it('exits once the last client leaves and nothing is running', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-idle-'));
    const started = await startDaemon(root, { AGENTFLOW_IDLE_SHUTDOWN_MS: '300' });
    child = started.proc;

    // Attaching and leaving is what disabling the extension looks like.
    await handshake(started.endpoint, root);

    const exited = await withTimeout(
      new Promise<number | null>((res) => started.proc.once('exit', (code) => res(code))),
      10_000, 'idle exit', 'the daemon is still up and should not be',
    );
    expect(exited).toBe(0);
    // The lock must go with it, or the next window attaches to a corpse.
    expect(existsSync(workspacePaths(root).lockFile)).toBe(false);
  }, 30_000);

  it('stays up while a client is attached', async () => {
    root = mkdtempSync(join(tmpdir(), 'agentflow-idle-'));
    const started = await startDaemon(root, { AGENTFLOW_IDLE_SHUTDOWN_MS: '300' });
    child = started.proc;

    const socket = connect(started.endpoint);
    await new Promise<void>((res, rej) => {
      socket.once('connect', res);
      socket.once('error', rej);
    });
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    conn.listen();
    await conn.sendRequest(Methods.handshake, {
      protocolVersion: PROTOCOL_VERSION, workspaceRoot: root, clientId: 'held-open',
    });

    await new Promise((r) => setTimeout(r, 1_500));
    expect(started.proc.exitCode).toBeNull();

    conn.dispose();
    socket.destroy();
  }, 30_000);
});
