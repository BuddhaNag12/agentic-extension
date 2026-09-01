import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  createMessageConnection, SocketMessageReader, SocketMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import {
  Methods, Notifications, PROTOCOL_VERSION,
  type EnvelopedEvent, type HandshakeResult, type PendingChangedNotification, type Run,
} from '@agentflow/protocol';
import { readLiveLock, workspacePaths } from '@agentflow/orchestrator';

/**
 * The extension host's RPC client (§2.2, §2.3). It attaches to a running
 * daemon if one exists and spawns one otherwise, so a window reload never
 * kills an in-flight run. The extension host does no model calls, runs no
 * tests, and holds no long loops — a blocked event loop freezes the editor.
 */
export class OrchestratorClient extends EventEmitter {
  private connection: MessageConnection | undefined;
  private socket: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly daemonEntry: string,
    private readonly log: (message: string) => void,
  ) {
    super();
    this.setMaxListeners(64);
  }

  get connected(): boolean {
    return this.connection !== undefined;
  }

  async ensureConnected(): Promise<void> {
    if (this.connection) return;
    this.connecting ??= this.doConnect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const paths = workspacePaths(this.workspaceRoot);
    let endpoint = readLiveLock(paths.lockFile)?.endpoint;

    if (endpoint) {
      this.log(`attaching to existing orchestrator at ${endpoint}`);
    } else {
      endpoint = await this.spawnDaemon(paths.lockFile);
    }

    this.socket = await connectWithRetry(endpoint);
    this.connection = createMessageConnection(
      new SocketMessageReader(this.socket),
      new SocketMessageWriter(this.socket),
    );

    this.connection.onNotification(Notifications.event, (p: EnvelopedEvent) => this.emit('event', p));
    this.connection.onNotification(Notifications.runUpdated, (p: { run: Run }) => this.emit('runUpdated', p.run));
    this.connection.onNotification(Notifications.pendingChanged, (p: PendingChangedNotification) => this.emit('pendingChanged', p));
    this.connection.onClose(() => this.handleDrop());
    this.socket.on('error', (err) => this.log(`socket error: ${err.message}`));
    this.connection.listen();

    const result = await this.connection.sendRequest<HandshakeResult>(Methods.handshake, {
      protocolVersion: PROTOCOL_VERSION,
      workspaceRoot: this.workspaceRoot,
      clientId: `vscode-${process.pid}`,
    });
    this.log(`connected to orchestrator ${result.orchestratorVersion} (pid ${result.pid})`);
    this.emit('connected', result);
  }

  /**
   * Spawns the daemon detached, so it outlives this window. Its first stdout
   * line reports the endpoint it bound.
   */
  private spawnDaemon(lockFile: string): Promise<string> {
    this.log('spawning orchestrator daemon');
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [this.daemonEntry, '--workspace', this.workspaceRoot], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AGENTFLOW_FAKE_TIME_SCALE: process.env['AGENTFLOW_FAKE_TIME_SCALE'] ?? '1' },
      });

      const timer = setTimeout(() => reject(new Error('orchestrator did not report an endpoint within 10s')), 10_000);
      const finish = (endpoint: string) => {
        clearTimeout(timer);
        child.unref();
        resolve(endpoint);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { status: string; endpoint?: string };
            if (msg.status === 'listening' && msg.endpoint) return finish(msg.endpoint);
            // Lost a spawn race with another window: use the winner's endpoint.
            if (msg.status === 'already-running' && msg.endpoint) return finish(msg.endpoint);
          } catch {
            this.log(`orchestrator: ${line}`);
          }
        }
      });
      child.stderr?.on('data', (c: Buffer) => this.log(c.toString('utf8').trimEnd()));
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        const lock = readLiveLock(lockFile);
        if (lock) return finish(lock.endpoint);
        clearTimeout(timer);
        reject(new Error(`orchestrator exited with code ${code} before listening`));
      });
    });
  }

  private handleDrop(): void {
    if (this.disposed) return;
    this.log('orchestrator connection closed');
    this.connection = undefined;
    this.socket = undefined;
    this.emit('disconnected');
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureConnected();
    if (!this.connection) throw new Error('orchestrator is not connected');
    return this.connection.sendRequest<T>(method, params);
  }

  listRuns(): Promise<{ runs: Run[] }> {
    return this.request(Methods.listRuns, {});
  }

  createRun(params: { ticketKey: string; summary?: string; profile?: string }): Promise<{ run: Run }> {
    return this.request(Methods.createRun, params);
  }

  startRun(runId: string): Promise<unknown> {
    return this.request(Methods.startRun, { runId });
  }

  cancelRun(runId: string): Promise<unknown> {
    return this.request(Methods.cancelRun, { runId });
  }

  getEvents(runId: string, sinceSeq = 0): Promise<{ events: unknown[] }> {
    return this.request(Methods.getEvents, { runId, sinceSeq });
  }

  listPending(): Promise<PendingChangedNotification> {
    return this.request(Methods.listPending, {});
  }

  answerQuestion(params: { runId: string; questionId: string; choice?: string; freeText?: string; deferred?: boolean }): Promise<unknown> {
    return this.request(Methods.answerQuestion, params);
  }

  decideApproval(params: { runId: string; approvalId: string; gate: string; decision: string; note?: string }): Promise<unknown> {
    return this.request(Methods.decideApproval, params);
  }

  dispose(): void {
    this.disposed = true;
    // The daemon deliberately keeps running: a reload must not kill a run.
    this.connection?.dispose();
    this.socket?.destroy();
  }
}

async function connectWithRetry(endpoint: string, attempts = 20): Promise<Socket> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(endpoint);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 50 + i * 25));
    }
  }
  throw new Error(`could not connect to orchestrator at ${endpoint}: ${String(lastError)}`);
}
