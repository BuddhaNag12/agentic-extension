import * as vscode from 'vscode';
import { join } from 'node:path';
import type { PendingChangedNotification, Run } from '@agentflow/protocol';
import { OrchestratorClient } from './client/orchestratorClient.js';
import { RunsTreeProvider } from './views/runsTree.js';
import { InboxTreeProvider, type InboxNode } from './views/inboxTree.js';
import { RunDetailPanel } from './views/runDetailPanel.js';
import { StatusBar } from './statusBar.js';

/**
 * The extension host stays thin (§2.2): it renders, captures intent, and talks
 * to the daemon. No model calls, no test execution, no long loops — the host
 * is single-threaded and shared with every other extension in the window.
 */

let client: OrchestratorClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    // Nothing to orchestrate without a folder; stay dormant rather than erroring.
    return;
  }

  const output = vscode.window.createOutputChannel('AgentFlow');
  context.subscriptions.push(output);
  const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);

  const daemonEntry = context.asAbsolutePath(join('dist', 'orchestrator.js'));
  client = new OrchestratorClient(workspace.uri.fsPath, daemonEntry, log);
  context.subscriptions.push(new vscode.Disposable(() => client?.dispose()));

  const runsTree = new RunsTreeProvider(client);
  const inbox = new InboxTreeProvider(client);
  const statusBar = new StatusBar(client, inbox);
  context.subscriptions.push(statusBar);

  const runsView = vscode.window.createTreeView('agentflow.runs', { treeDataProvider: runsTree });
  const inboxView = vscode.window.createTreeView('agentflow.inbox', { treeDataProvider: inbox });
  context.subscriptions.push(runsView, inboxView);

  client.on('pendingChanged', (p: PendingChangedNotification) => {
    const count = p.approvals.length + p.questions.length;
    inboxView.badge = count > 0 ? { value: count, tooltip: `${count} awaiting you` } : undefined;
    // Notify only for things that actually need a human (§10.1).
    for (const approval of p.approvals) {
      void notifyOnce(context, `approval:${approval.id}`, `${approval.gate}: ${approval.summary}`, () =>
        vscode.commands.executeCommand('agentflow.answerNext'),
      );
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('agentflow.createRun', () => createRun(runsTree)),
    vscode.commands.registerCommand('agentflow.refresh', async () => {
      await Promise.all([runsTree.refresh(), inbox.refresh(), statusBar.reload()]);
    }),
    vscode.commands.registerCommand('agentflow.openRun', async (runId?: string) => {
      const run = await pickRun(runId);
      if (run && client) RunDetailPanel.show(run.id, run.ticket.key, client);
    }),
    vscode.commands.registerCommand('agentflow.cancelRun', async (node?: { run: Run }) => {
      const run = node?.run ?? (await pickRun(undefined));
      if (!run) return;
      const yes = await vscode.window.showWarningMessage(
        `Cancel ${run.ticket.key}? The branch and worktree are kept.`, { modal: true }, 'Cancel run',
      );
      if (yes) await client?.cancelRun(run.id);
    }),
    vscode.commands.registerCommand('agentflow.answerNext', (node?: InboxNode) => respond(node ?? inbox.first())),
    vscode.commands.registerCommand('agentflow.showLog', () => output.show()),
    vscode.commands.registerCommand('agentflow.restartOrchestrator', async () => {
      client?.dispose();
      client = new OrchestratorClient(workspace.uri.fsPath, daemonEntry, log);
      await client.ensureConnected();
      await vscode.commands.executeCommand('agentflow.refresh');
    }),
  );

  if (vscode.workspace.getConfiguration('agentflow').get<boolean>('orchestrator.autoStart', true)) {
    try {
      await client.ensureConnected();
      await Promise.all([runsTree.refresh(), inbox.refresh(), statusBar.reload()]);
    } catch (err) {
      log(`could not start orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showErrorMessage('AgentFlow: orchestrator failed to start. See the AgentFlow output channel.');
    }
  }
}

export function deactivate(): void {
  // The daemon deliberately survives: a reload must not kill a running ticket.
  client?.dispose();
}

async function createRun(runsTree: RunsTreeProvider): Promise<void> {
  const ticketKey = await vscode.window.showInputBox({
    title: 'Start an AgentFlow run',
    prompt: 'Ticket key',
    placeHolder: 'PAY-1423',
    validateInput: (v) => (/^[A-Z][A-Z0-9_]+-\d+$/.test(v.trim()) ? undefined : 'Expected a key like PAY-1423'),
  });
  if (!ticketKey) return;

  const profile = await vscode.window.showQuickPick(
    [
      { label: 'feature', description: 'Full pipeline' },
      { label: 'bug', description: 'Reproduction test required before the fix' },
      { label: 'chore', description: 'Skips clarify unless a question blocks' },
      { label: 'refactor', description: 'Behaviour-preservation gate required' },
      { label: 'spike', description: 'Produces a document, never ships code' },
    ],
    { title: 'Pipeline profile' },
  );
  if (!profile || !client) return;

  const { run } = await client.createRun({ ticketKey: ticketKey.trim(), profile: profile.label });
  await client.startRun(run.id);
  await runsTree.refresh();
  RunDetailPanel.show(run.id, run.ticket.key, client);
}

async function pickRun(runId?: string): Promise<Run | undefined> {
  if (!client) return undefined;
  const { runs } = await client.listRuns();
  if (runId) return runs.find((r) => r.id === runId);
  if (runs.length === 0) {
    void vscode.window.showInformationMessage('AgentFlow: no runs yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    runs.map((run) => ({ label: run.ticket.key, description: `${run.phase} · ${run.status}`, run })),
    { title: 'Select a run' },
  );
  return picked?.run;
}

/**
 * Approvals and questions are presented as one form per item, with the
 * evidence the agent already gathered attached — §7.2's `alreadyChecked` is
 * how you find out the agent is asking things the repo already answers.
 */
async function respond(node: InboxNode | undefined): Promise<void> {
  if (!node || !client) {
    void vscode.window.showInformationMessage('AgentFlow: nothing is waiting on you.');
    return;
  }

  if (node.kind === 'approval') {
    const { approval } = node;
    const decision = await vscode.window.showQuickPick(
      [
        { label: 'Approve', value: 'approve', description: 'Continue to the next phase' },
        { label: 'Request revision', value: 'revise', description: 'Send it back with a note' },
        { label: 'Reject', value: 'reject', description: 'Abandon the run, keep the branch' },
      ],
      { title: `${approval.gate} — ${approval.summary}`, placeHolder: `$${approval.cost.soFarUsd.toFixed(2)} spent so far` },
    );
    if (!decision) return;

    const note = decision.value === 'revise'
      ? await vscode.window.showInputBox({ title: 'What should change?', ignoreFocusOut: true })
      : undefined;

    await client.decideApproval({
      runId: approval.runId,
      approvalId: approval.id,
      gate: approval.gate,
      decision: decision.value,
      ...(note ? { note } : {}),
    });
    return;
  }

  const { question, runId } = node;
  const options = question.options ?? [];
  const picked = await vscode.window.showQuickPick(
    [
      ...options.map((o) => ({ label: o.label, detail: o.implication, value: o.label })),
      ...(question.allowFreeText ? [{ label: 'Something else…', detail: 'Type an answer', value: '__free__' }] : []),
      ...(question.blocking ? [] : [{ label: 'Defer', detail: 'Use the agent’s default', value: '__defer__' }]),
    ],
    {
      title: question.question,
      placeHolder: question.whyItMatters,
      ignoreFocusOut: true,
    },
  );
  if (!picked) return;

  if (picked.value === '__free__') {
    const freeText = await vscode.window.showInputBox({ title: question.question, ignoreFocusOut: true });
    if (!freeText) return;
    await client.answerQuestion({ runId, questionId: question.id, freeText });
    return;
  }
  if (picked.value === '__defer__') {
    await client.answerQuestion({ runId, questionId: question.id, deferred: true });
    return;
  }
  await client.answerQuestion({ runId, questionId: question.id, choice: picked.value });
}

/** Notify at most once per item, so a re-render never re-nags. */
async function notifyOnce(
  context: vscode.ExtensionContext,
  key: string,
  message: string,
  onClick: () => void,
): Promise<void> {
  const shown = context.workspaceState.get<string[]>('agentflow.notified', []);
  if (shown.includes(key)) return;
  await context.workspaceState.update('agentflow.notified', [...shown.slice(-200), key]);
  const action = await vscode.window.showInformationMessage(message, 'Decide');
  if (action) onClick();
}
