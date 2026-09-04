import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMessageConnection, SocketMessageReader, SocketMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import {
  Methods, Notifications, PROTOCOL_VERSION,
  type EnvelopedEvent, type HandshakeResult, type PendingChangedNotification, type Run,
} from '@agentflow/protocol';
import { Orchestrator } from './daemon.js';
import { workspacePaths } from './paths.js';
import { readLiveLock } from './lock.js';

/**
 * The M0 exit criterion, end to end: a fake run walks every phase over the
 * real socket transport, parking at all three human gates, with the UI's view
 * derived entirely from streamed events.
 */

process.env['AGENTFLOW_FAKE_TIME_SCALE'] = '0.02';
process.env['AGENTFLOW_SIMULATE'] = '1';

let root: string;
let orchestrator: Orchestrator;
let client: MessageConnection;
const events: EnvelopedEvent[] = [];
let pending: PendingChangedNotification = { questions: [], approvals: [] };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentflow-ws-'));
  const paths = workspacePaths(root);
  orchestrator = new Orchestrator(paths);
  const endpoint = await orchestrator.listen();

  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  client = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
  client.onNotification(Notifications.event, (p: EnvelopedEvent) => { events.push(p); });
  client.onNotification(Notifications.pendingChanged, (p: PendingChangedNotification) => { pending = p; });
  client.listen();
  events.length = 0;
  pending = { questions: [], approvals: [] };
});

afterEach(() => {
  client.dispose();
  orchestrator.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const handshake = () =>
  client.sendRequest<HandshakeResult>(Methods.handshake, {
    protocolVersion: PROTOCOL_VERSION, workspaceRoot: root, clientId: 'test',
  });

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const phasesSeen = () => events.filter((e) => e.event.t === 'phase_entered').map((e) => (e.event as { phase: string }).phase);
const statusOf = async (runId: string) =>
  (await client.sendRequest<{ run: Run }>(Methods.getRun, { runId })).run.status;

describe('handshake and lifecycle', () => {
  it('agrees on the protocol version and writes a live lockfile', async () => {
    const result = await handshake();
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(readLiveLock(workspacePaths(root).lockFile)?.pid).toBe(process.pid);
  });

  it('refuses a client speaking a different protocol version', async () => {
    await expect(
      client.sendRequest(Methods.handshake, { protocolVersion: 999, workspaceRoot: root, clientId: 'x' }),
    ).rejects.toThrow(/protocol mismatch/);
  });
});

describe('a fake run walks the pipeline (M0 exit)', () => {
  it('reaches done through exactly three human gates', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, {
      ticketKey: 'PAY-1423', summary: 'Checkout empty state',
    });
    await client.sendRequest(Methods.startRun, { runId: run.id });

    for (const gate of ['G1', 'G2', 'G3'] as const) {
      await waitFor(() => pending.approvals.some((a) => a.gate === gate), `gate ${gate}`);
      expect(await statusOf(run.id)).toBe('waiting_human');

      const approval = pending.approvals.find((a) => a.gate === gate)!;
      await client.sendRequest(Methods.decideApproval, {
        runId: run.id, approvalId: approval.id, gate, decision: 'approve',
      });
    }

    await waitFor(async () => (await statusOf(run.id)) === 'succeeded', 'run to succeed');
    expect(await statusOf(run.id)).toBe('succeeded');

    expect(phasesSeen()).toEqual([
      'intake', 'harvest', 'spec', 'clarify', 'plan', 'decompose',
      'implement', 'verify', 'review', 'human_review', 'ship', 'done',
    ]);
  });

  it('streams the events the UI needs while running', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-1' });
    await client.sendRequest(Methods.startRun, { runId: run.id });

    await waitFor(() => pending.approvals.length > 0, 'first gate');
    const kinds = new Set(events.map((e) => e.event.t));
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('artifact_written');
    expect(kinds).toContain('cost');
    expect(kinds).toContain('question_asked');
  });

  it('asks its clarifying question with evidence of what it already checked', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-1' });
    await client.sendRequest(Methods.startRun, { runId: run.id });

    await waitFor(() => pending.questions.length > 0, 'a question');
    const q = pending.questions[0]!.question;
    expect(q.alreadyChecked.length).toBeGreaterThan(0);
    expect(q.blocking).toBe(true);
  });

  it('sends a rejected gate to cancelled rather than onward', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-2' });
    await client.sendRequest(Methods.startRun, { runId: run.id });

    await waitFor(() => pending.approvals.some((a) => a.gate === 'G1'), 'G1');
    const approval = pending.approvals.find((a) => a.gate === 'G1')!;
    await client.sendRequest(Methods.decideApproval, {
      runId: run.id, approvalId: approval.id, gate: 'G1', decision: 'reject',
    });

    await waitFor(async () => (await statusOf(run.id)) === 'cancelled', 'cancellation');
    expect(phasesSeen()).not.toContain('implement');
  });
});

describe('a finished run stops accepting decisions', () => {
  const finish = async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-5' });
    await client.sendRequest(Methods.startRun, { runId: run.id });
    for (const gate of ['G1', 'G2', 'G3'] as const) {
      await waitFor(() => pending.approvals.some((a) => a.gate === gate), `gate ${gate}`);
      const approval = pending.approvals.find((a) => a.gate === gate)!;
      await client.sendRequest(Methods.decideApproval, { runId: run.id, approvalId: approval.id, gate, decision: 'approve' });
    }
    await waitFor(async () => (await statusOf(run.id)) === 'succeeded', 'completion');
    return run;
  };

  it('withdraws its pending approvals from the inbox', async () => {
    const run = await finish();
    await waitFor(() => pending.approvals.every((a) => a.runId !== run.id), 'inbox to clear');
    expect(pending.approvals.filter((a) => a.runId === run.id)).toEqual([]);
  });

  it('refuses a late approval instead of logging an error', async () => {
    const run = await finish();
    const before = events.length;

    const result = await client.sendRequest<{ ok: boolean; reason?: string }>(Methods.decideApproval, {
      runId: run.id, approvalId: 'stale-id', gate: 'G3', decision: 'approve',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already finished');

    // Nothing is written: no phantom approval_decided, no state_machine error.
    const after = events.slice(before).map((e) => e.event.t);
    expect(after).not.toContain('approval_decided');
    expect(after).not.toContain('error');
  });

  it('refuses a late answer to a question', async () => {
    const run = await finish();
    const result = await client.sendRequest<{ ok: boolean; reason?: string }>(Methods.answerQuestion, {
      runId: run.id, questionId: 'stale', choice: 'x',
    });
    expect(result.ok).toBe(false);
  });

  it('records that the pending items were withdrawn', async () => {
    const run = await finish();
    await waitFor(
      () => events.some((e) => e.runId === run.id && e.event.t === 'log'
        && (e.event as { message: string }).message.includes('withdrew')),
      'withdrawal log',
    );
  });
});

describe('persistence (§13)', () => {
  it('rebuilds runs by replaying the log after a daemon restart', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-9' });
    await client.sendRequest(Methods.startRun, { runId: run.id });
    await waitFor(() => pending.approvals.length > 0, 'G1');

    const before = await statusOf(run.id);
    client.dispose();
    orchestrator.shutdown();

    // A fresh daemon on the same workspace must recover the run from disk.
    const revived = new Orchestrator(workspacePaths(root));
    const endpoint = await revived.listen();
    const socket = connect(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const client2 = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    client2.listen();

    const { runs } = await client2.sendRequest<{ runs: Run[] }>(Methods.listRuns, {});
    expect(runs.map((r) => r.id)).toContain(run.id);
    expect(runs.find((r) => r.id === run.id)?.status).toBe(before);

    client2.dispose();
    revived.shutdown();
  });

  it('serves the event history to a client that attaches late', async () => {
    await handshake();
    const { run } = await client.sendRequest<{ run: Run }>(Methods.createRun, { ticketKey: 'PAY-7' });
    await client.sendRequest(Methods.startRun, { runId: run.id });
    await waitFor(() => events.length > 6, 'some events');

    const all = await client.sendRequest<{ events: { seq: number }[] }>(Methods.getEvents, { runId: run.id, sinceSeq: 0 });
    expect(all.events.length).toBeGreaterThan(6);
    expect(all.events.map((e) => e.seq)).toEqual([...all.events.map((e) => e.seq)].sort((a, b) => a - b));

    const tail = await client.sendRequest<{ events: { seq: number }[] }>(Methods.getEvents, { runId: run.id, sinceSeq: 5 });
    expect(tail.events[0]?.seq).toBe(5);
  });
});
