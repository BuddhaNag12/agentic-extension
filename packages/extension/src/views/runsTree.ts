import * as vscode from 'vscode';
import type { Run, RunStatus } from '@agentflow/protocol';
import type { OrchestratorClient } from '../client/orchestratorClient.js';

/**
 * The Runs tree (§10.1): every run grouped by status, with phase, elapsed and
 * spend on the row. Updates are pushed from the event stream — never polled.
 */

type Node = StatusGroup | RunNode;
interface StatusGroup { kind: 'group'; status: RunStatus; runs: Run[] }
interface RunNode { kind: 'run'; run: Run }

const GROUP_ORDER: RunStatus[] = [
  'waiting_human', 'running', 'blocked', 'queued', 'failed', 'succeeded', 'cancelled',
];

const GROUP_LABEL: Record<RunStatus, string> = {
  waiting_human: 'Needs you',
  running: 'Running',
  blocked: 'Blocked',
  queued: 'Queued',
  failed: 'Failed',
  succeeded: 'Done',
  cancelled: 'Cancelled',
};

const PHASE_ICON: Record<string, string> = {
  intake: 'inbox', harvest: 'search', spec: 'note', clarify: 'question',
  plan: 'list-tree', decompose: 'symbol-structure', implement: 'edit',
  verify: 'beaker', repair: 'tools', review: 'eye', wait_for_ci: 'cloud',
  human_review: 'git-pull-request', ship: 'rocket', done: 'pass-filled',
};

export class RunsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private runs: Run[] = [];
  /** Coalesced so a burst of events cannot re-render the tree per token (§10.3). */
  private repaint: NodeJS.Timeout | undefined;

  constructor(private readonly client: OrchestratorClient) {
    client.on('runUpdated', (run: Run) => this.upsert(run));
    client.on('connected', () => void this.refresh());
  }

  async refresh(): Promise<void> {
    try {
      this.runs = (await this.client.listRuns()).runs;
      this.changed.fire(undefined);
    } catch {
      // A disconnected daemon is reported by the status bar, not by throwing here.
    }
  }

  private upsert(run: Run): void {
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.runs[i] = run;
    else this.runs.unshift(run);
    this.scheduleRepaint();
  }

  private scheduleRepaint(): void {
    if (this.repaint) return;
    this.repaint = setTimeout(() => {
      this.repaint = undefined;
      this.changed.fire(undefined);
    }, 100);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return GROUP_ORDER
        .map((status) => ({ kind: 'group' as const, status, runs: this.runs.filter((r) => r.status === status) }))
        .filter((g) => g.runs.length > 0);
    }
    if (node.kind === 'group') return node.runs.map((run) => ({ kind: 'run' as const, run }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        `${GROUP_LABEL[node.status]} (${node.runs.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'group';
      return item;
    }

    const { run } = node;
    const item = new vscode.TreeItem(run.ticket.key, vscode.TreeItemCollapsibleState.None);
    item.description = `${run.phase} · ${elapsed(run)} · $${run.cost.usd.toFixed(2)}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${run.ticket.key}** — ${run.ticket.summary}`,
        '',
        `- Phase: \`${run.phase}\``,
        `- Status: \`${run.status}\``,
        `- Branch: \`${run.branch}\``,
        `- Profile: \`${run.ticket.profile}\``,
        `- Spend: $${run.cost.usd.toFixed(2)}`,
      ].join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      PHASE_ICON[run.phase] ?? 'circle-outline',
      run.status === 'waiting_human' ? new vscode.ThemeColor('charts.yellow')
        : run.status === 'blocked' || run.status === 'failed' ? new vscode.ThemeColor('charts.red')
        : run.status === 'succeeded' ? new vscode.ThemeColor('charts.green')
        : undefined,
    );
    item.contextValue = 'run';
    item.command = { command: 'agentflow.openRun', title: 'Open Run', arguments: [run.id] };
    return item;
  }
}

function elapsed(run: Run): string {
  const seconds = Math.max(0, Math.round((run.updatedAt - run.createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
