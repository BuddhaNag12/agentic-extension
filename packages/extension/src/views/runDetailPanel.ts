import * as vscode from 'vscode';
import type { EnvelopedEvent, Run, RunEvent } from '@agentflow/protocol';
import type { OrchestratorClient } from '../client/orchestratorClient.js';

/**
 * Run detail (§10.1): the event log rendered as a live timeline. Events are
 * appended incrementally and coalesced — a long run produces tens of thousands
 * of them, and re-rendering the whole list on each one would jank the window.
 */
export class RunDetailPanel {
  private static readonly panels = new Map<string, RunDetailPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private queue: RunEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly runId: string,
    private readonly client: OrchestratorClient,
  ) {
    this.panel.webview.html = this.html();

    const onEvent = (payload: EnvelopedEvent) => {
      if (payload.runId === this.runId) this.enqueue(payload.event);
    };
    const onRun = (run: Run) => {
      if (run.id === this.runId) void this.post({ type: 'run', run });
    };
    client.on('event', onEvent);
    client.on('runUpdated', onRun);

    this.disposables.push(
      new vscode.Disposable(() => {
        client.off('event', onEvent);
        client.off('runUpdated', onRun);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );

    void this.hydrate();
  }

  static show(runId: string, ticketKey: string, client: OrchestratorClient): void {
    const existing = RunDetailPanel.panels.get(runId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentflow.runDetail',
      `${ticketKey} — AgentFlow`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    RunDetailPanel.panels.set(runId, new RunDetailPanel(panel, runId, client));
  }

  private async hydrate(): Promise<void> {
    const [{ events }, { runs }] = await Promise.all([
      this.client.getEvents(this.runId, 0),
      this.client.listRuns(),
    ]);
    const run = runs.find((r) => r.id === this.runId);
    await this.post({ type: 'hydrate', events, ...(run ? { run } : {}) });
  }

  /** Batch at ~10 fps; the DOM cannot usefully show more than that anyway. */
  private enqueue(event: RunEvent): void {
    this.queue.push(event);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const batch = this.queue;
      this.queue = [];
      void this.post({ type: 'append', events: batch });
    }, 100);
  }

  private async post(message: unknown): Promise<void> {
    // Posting to a disposed webview rejects; the panel is going away anyway.
    try {
      await this.panel.webview.postMessage(message);
    } catch { /* ignore */ }
  }

  private dispose(): void {
    RunDetailPanel.panels.delete(this.runId);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    margin: 0; padding: 16px 20px;
  }
  h1 { font-size: 1.15rem; margin: 0 0 2px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: .85rem; margin-bottom: 14px; }
  .pipeline { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 18px; }
  .phase {
    font-size: .72rem; padding: 3px 8px; border-radius: 10px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .phase.visited { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .phase.current {
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-color: transparent; font-weight: 600;
  }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 10px 3px 0; vertical-align: top; font-size: .82rem; border-bottom: 1px solid var(--vscode-panel-border); }
  td.time { color: var(--vscode-descriptionForeground); white-space: nowrap; width: 1%; font-variant-numeric: tabular-nums; }
  td.kind { white-space: nowrap; width: 1%; }
  .tag { font-size: .7rem; padding: 1px 6px; border-radius: 3px; background: var(--vscode-textBlockQuote-background); }
  .ok { color: var(--vscode-testing-iconPassed); }
  .bad { color: var(--vscode-testing-iconFailed); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
  <h1 id="title">Run</h1>
  <div class="sub" id="sub"></div>
  <div class="pipeline" id="pipeline"></div>
  <table><tbody id="rows"></tbody></table>
<script nonce="${nonce}">
const PHASES = ['intake','harvest','spec','clarify','plan','decompose','implement','verify','repair','review','human_review','ship','done'];
const rows = document.getElementById('rows');
const visited = new Set();
let current = 'intake';
let t0 = null;

function describe(e) {
  switch (e.t) {
    case 'run_created': return ['run', 'created on <code>' + e.branch + '</code>'];
    case 'phase_entered': return ['phase', '→ <b>' + e.phase + '</b>'];
    case 'status_changed': return ['status', e.status + (e.reason ? ' — ' + e.reason : '')];
    case 'artifact_written': return ['artifact', e.kind + '.v' + e.version];
    case 'question_asked': return ['question', '<span class="warn">' + e.question.question + '</span>'];
    case 'question_answered': return ['answered', e.questionId];
    case 'approval_requested': return ['gate', '<b>' + e.gate + '</b> awaiting decision'];
    case 'approval_decided': return ['gate', '<b>' + e.gate + '</b> ' + e.decision + ' by ' + e.decidedBy];
    case 'task_status': return ['task', e.taskId + ' → ' + e.status];
    case 'tool_call': return ['tool', '<code>' + e.tool + '</code>'];
    case 'tool_result': return ['result', (e.ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + e.summaryLine];
    case 'file_changed': return ['file', e.op + ' <code>' + e.path + '</code> (' + e.hunks + ' hunks)'];
    case 'checkpoint': return ['checkpoint', e.label];
    case 'gate_result': return ['gate', e.gate + (e.ok ? ' <span class="ok">passed</span>' : ' <span class="bad">failed</span>') + ' in ' + e.durationMs + 'ms'];
    case 'cost': return ['cost', '$' + e.usd.toFixed(3) + ' · ' + e.model];
    case 'log': return ['log', e.message];
    case 'error': return ['error', '<span class="bad">' + e.message + '</span>'];
    default: return [e.t, ''];
  }
}

function append(events) {
  const frag = document.createDocumentFragment();
  for (const e of events) {
    if (t0 === null) t0 = e.at;
    if (e.t === 'phase_entered') { visited.add(e.phase); current = e.phase; }
    const [kind, detail] = describe(e);
    const tr = document.createElement('tr');
    const secs = ((e.at - t0) / 1000).toFixed(1);
    tr.innerHTML = '<td class="time">+' + secs + 's</td>'
      + '<td class="kind"><span class="tag">' + kind + '</span></td>'
      + '<td>' + detail + '</td>';
    frag.appendChild(tr);
  }
  rows.appendChild(frag);
  drawPipeline();
  window.scrollTo(0, document.body.scrollHeight);
}

function drawPipeline() {
  const el = document.getElementById('pipeline');
  el.innerHTML = '';
  for (const p of PHASES) {
    const d = document.createElement('div');
    d.className = 'phase' + (p === current ? ' current' : visited.has(p) ? ' visited' : '');
    d.textContent = p;
    el.appendChild(d);
  }
}

function setRun(run) {
  if (!run) return;
  document.getElementById('title').textContent = run.ticket.key + ' — ' + run.ticket.summary;
  document.getElementById('sub').textContent =
    run.status + ' · ' + run.phase + ' · $' + run.cost.usd.toFixed(2)
    + ' · ' + run.ticket.profile + ' · ' + run.branch;
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'hydrate') { rows.innerHTML = ''; t0 = null; visited.clear(); append(msg.events); setRun(msg.run); }
  else if (msg.type === 'append') append(msg.events);
  else if (msg.type === 'run') setRun(msg.run);
});
drawPipeline();
</script>
</body></html>`;
  }
}
