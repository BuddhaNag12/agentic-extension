import * as vscode from 'vscode';
import type { Run } from '@agentflow/protocol';
import type { OrchestratorClient } from './client/orchestratorClient.js';
import type { InboxTreeProvider } from './views/inboxTree.js';

/** `⟳ 3 running · 1 needs you · $2.14` (§10.1). */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private runs: Run[] = [];
  private connected = false;

  constructor(private readonly client: OrchestratorClient, private readonly inbox: InboxTreeProvider) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'agentflow.refresh';
    this.item.show();
    this.render();

    client.on('connected', () => { this.connected = true; void this.reload(); });
    client.on('disconnected', () => { this.connected = false; this.render(); });
    client.on('runUpdated', (run: Run) => {
      const i = this.runs.findIndex((r) => r.id === run.id);
      if (i >= 0) this.runs[i] = run; else this.runs.push(run);
      this.render();
    });
    client.on('pendingChanged', () => this.render());
  }

  async reload(): Promise<void> {
    try {
      this.runs = (await this.client.listRuns()).runs;
    } catch { /* status text will say disconnected */ }
    this.render();
  }

  private render(): void {
    if (!this.connected) {
      this.item.text = '$(circle-slash) AgentFlow';
      this.item.tooltip = 'Orchestrator not connected';
      this.item.backgroundColor = undefined;
      return;
    }

    const running = this.runs.filter((r) => r.status === 'running').length;
    const needsYou = this.inbox.count;
    const spend = this.runs.reduce((sum, r) => sum + r.cost.usd, 0);

    const parts = [`$(sync) ${running} running`];
    if (needsYou > 0) parts.push(`${needsYou} needs you`);
    parts.push(`$${spend.toFixed(2)}`);

    this.item.text = parts.join(' · ');
    this.item.tooltip = 'AgentFlow — click to refresh';
    // Only a blocked human decision earns a coloured status bar.
    this.item.backgroundColor = needsYou > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
