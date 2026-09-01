import * as vscode from 'vscode';
import type { ApprovalRequest, PendingChangedNotification, Question } from '@agentflow/protocol';
import type { OrchestratorClient } from '../client/orchestratorClient.js';

/**
 * The inbox (§10.1, §7): every pending question and approval across all runs,
 * in one place. Batching them here is what lets a human answer three runs in
 * one sitting instead of being interrupted per run.
 */

type Node =
  | { kind: 'approval'; approval: ApprovalRequest }
  | { kind: 'question'; runId: string; question: Question };

export class InboxTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private pending: PendingChangedNotification = { questions: [], approvals: [] };

  constructor(private readonly client: OrchestratorClient) {
    client.on('pendingChanged', (p: PendingChangedNotification) => {
      this.pending = p;
      this.changed.fire(undefined);
    });
    client.on('connected', () => void this.refresh());
  }

  get count(): number {
    return this.pending.approvals.length + this.pending.questions.length;
  }

  async refresh(): Promise<void> {
    try {
      this.pending = await this.client.listPending();
      this.changed.fire(undefined);
    } catch {
      // Connection problems surface in the status bar.
    }
  }

  first(): Node | undefined {
    return this.getChildren()[0];
  }

  getChildren(): Node[] {
    return [
      ...this.pending.approvals.map((approval) => ({ kind: 'approval' as const, approval })),
      ...this.pending.questions.map((q) => ({ kind: 'question' as const, runId: q.runId, question: q.question })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'approval') {
      const item = new vscode.TreeItem(`${node.approval.gate} · ${node.approval.summary}`);
      item.iconPath = new vscode.ThemeIcon('law', new vscode.ThemeColor('charts.yellow'));
      item.description = `$${node.approval.cost.soFarUsd.toFixed(2)} spent`;
      item.contextValue = 'approval';
      item.command = { command: 'agentflow.answerNext', title: 'Decide', arguments: [node] };
      return item;
    }

    const item = new vscode.TreeItem(node.question.question);
    item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.blue'));
    item.description = node.question.blocking ? 'blocking' : 'optional';
    item.tooltip = new vscode.MarkdownString(
      [
        node.question.question,
        '',
        `_${node.question.whyItMatters}_`,
        '',
        '**Already checked:**',
        ...node.question.alreadyChecked.map((c) => `- ${c}`),
      ].join('\n'),
    );
    item.contextValue = 'question';
    item.command = { command: 'agentflow.answerNext', title: 'Answer', arguments: [node] };
    return item;
  }
}

export type InboxNode = Node;
