import * as vscode from 'vscode';
import type {
  ApprovalRequest, EnvelopedEvent, PendingChangedNotification, Run, RunEvent,
  WorkInboxSnapshot,
} from '@agentflow/protocol';
import { GITHUB_TOKEN_KEY, JIRA_CREDS_KEY } from './pullRequests.js';
import type { OrchestratorClient } from '../client/orchestratorClient.js';

/**
 * The dashboard (§12.1): every run, every pending decision, and the live
 * activity line, in one editor tab.
 *
 * An editor tab rather than the sidebar because this is the surface you watch
 * — a swimlane per run with its phase pipeline lit needs width, and a 300px
 * column turns the seven phases into a scrollbar. The trees stay for the
 * badge and for quick access; this is where the work is read.
 *
 * Plain HTML rather than §12.4's React + Vite: the run detail panel already
 * established the pattern, and a bundler for one page would be the only build
 * step in the repo that exists to serve a single view. Worth revisiting when
 * the timeline needs virtualizing.
 */

interface Snapshot {
  runs: Run[];
  pending: PendingChangedNotification;
}

export class Dashboard {
  private static current: Dashboard | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private selected: string | undefined;
  private queue: RunEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private repaint: NodeJS.Timeout | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: OrchestratorClient,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.panel.webview.html = this.html();

    const onEvent = (p: EnvelopedEvent) => {
      // Only the selected run's events reach the activity line; the others
      // would be noise, and a dozen runs streaming at once would jank.
      if (p.runId === this.selected) this.enqueue(p.event);
    };
    const onRun = () => this.scheduleSnapshot();
    const onPending = (pending: PendingChangedNotification) => void this.post({ type: 'pending', pending });
    const onInbox = (inbox: WorkInboxSnapshot) => void this.post({ type: 'inbox', inbox });

    client.on('event', onEvent);
    client.on('runUpdated', onRun);
    client.on('pendingChanged', onPending);
    client.on('workInboxChanged', onInbox);
    client.on('connected', () => void this.snapshot());

    this.disposables.push(
      new vscode.Disposable(() => {
        client.off('event', onEvent);
        client.off('runUpdated', onRun);
        client.off('pendingChanged', onPending);
        client.off('workInboxChanged', onInbox);
      }),
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );

    void this.snapshot();
  }

  static show(
    client: OrchestratorClient,
    secrets: vscode.SecretStorage,
    column = vscode.ViewColumn.One,
    opts: { onlyIfHidden?: boolean; preserveFocus?: boolean } = {},
  ): void {
    if (Dashboard.current) {
      // `onlyIfHidden` is for the automatic openers. Revealing a panel that is
      // already in front does nothing useful and, when it is not the active
      // tab group, yanks focus away from whatever the human was reading.
      if (opts.onlyIfHidden && Dashboard.current.panel.visible) return;
      Dashboard.current.panel.reveal(column, opts.preserveFocus ?? false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentflow.dashboard',
      'AgentFlow',
      column,
      // Retained so switching tabs does not re-fetch and re-render everything;
      // the panel is meant to be left open.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    Dashboard.current = new Dashboard(panel, client, secrets);
  }

  static isOpen(): boolean {
    return Dashboard.current !== undefined;
  }

  static isVisible(): boolean {
    return Dashboard.current?.panel.visible ?? false;
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          return void (await this.snapshot());

        case 'select': {
          this.selected = m['runId'] as string;
          const { events } = await this.client.getEvents(this.selected, 0);
          return void (await this.post({ type: 'activity', runId: this.selected, events, reset: true }));
        }

        case 'start':
          return void (await vscode.commands.executeCommand('agentflow.createRun'));

        case 'reviewPr':
          return void (await vscode.commands.executeCommand('agentflow.reviewPullRequest'));

        case 'refreshInbox':
          return void (await this.loadInbox(true));

        case 'openItem':
          return void (await vscode.env.openExternal(vscode.Uri.parse(m['url'] as string)));

        case 'startFromItem': {
          const key = m['key'] as string;
          // One click now spends real money — harvest, spec and plan run
          // against live models. Free to click while it did nothing; not any
          // more, so it asks.
          const go = await vscode.window.showWarningMessage(
            `Plan ${key}?`,
            {
              modal: true,
              detail:
                'Runs harvest, spec and plan against real models — roughly $1.50 — ' +
                'then stops at the first approval gate.',
            },
            'Plan it',
          );
          if (go !== 'Plan it') return;

          // A ticket key is all `createRun` needs; the summary rides along so
          // the run reads as the ticket rather than as an identifier.
          const description = (m['description'] as string | undefined) ?? '';
          const labels = (m['labels'] as string[] | undefined) ?? [];
          const { run } = await this.client.createRun({
            ticketKey: key,
            summary: m['title'] as string,
            ...(description ? { description } : {}),
            ...(labels.length ? { labels } : {}),
          });
          // `createRun` only queues it. Without this the button creates a run
          // that sits at intake forever, which is what it did before.
          await this.client.startRun(run.id);
          return void (await this.snapshot());
        }

        case 'openDetail':
          return void (await vscode.commands.executeCommand('agentflow.openRun', m['runId']));

        case 'cancel': {
          const run = (await this.client.listRuns()).runs.find((r) => r.id === m['runId']);
          if (!run) return;
          const yes = await vscode.window.showWarningMessage(
            `Cancel ${run.ticket.key}? The branch and worktree are kept.`,
            { modal: true }, 'Cancel run',
          );
          if (yes) await this.client.cancelRun(run.id);
          return;
        }

        case 'decide': {
          // A revision needs a reason, and asking for it in a native input is
          // better than a textarea the webview has to validate.
          const decision = m['decision'] as string;
          const note = decision === 'revise'
            ? await vscode.window.showInputBox({ title: 'What should change?', ignoreFocusOut: true })
            : undefined;
          if (decision === 'revise' && note === undefined) return;

          await this.client.decideApproval({
            runId: m['runId'] as string,
            approvalId: m['approvalId'] as string,
            gate: m['gate'] as string,
            decision,
            ...(note ? { note } : {}),
          });
          return;
        }

        case 'answer': {
          const free = m['freeText'] as string | undefined;
          await this.client.answerQuestion({
            runId: m['runId'] as string,
            questionId: m['questionId'] as string,
            ...(m['choice'] ? { choice: m['choice'] as string } : {}),
            ...(free ? { freeText: free } : {}),
            ...(m['deferred'] ? { deferred: true } : {}),
          });
          return;
        }

        case 'answerOther': {
          const text = await vscode.window.showInputBox({
            title: 'Your answer', ignoreFocusOut: true,
          });
          if (!text) return;
          await this.client.answerQuestion({
            runId: m['runId'] as string,
            questionId: m['questionId'] as string,
            freeText: text,
          });
          return;
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `AgentFlow: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Coalesced: a burst of run updates must not re-render per event. */
  private scheduleSnapshot(): void {
    if (this.repaint) return;
    this.repaint = setTimeout(() => {
      this.repaint = undefined;
      void this.snapshot();
    }, 120);
  }

  private async snapshot(): Promise<void> {
    try {
      const [{ runs }, pending] = await Promise.all([
        this.client.listRuns(),
        this.client.listPending(),
      ]);
      // Default to whatever most wants attention, so the panel is useful the
      // moment it opens rather than after a click.
      this.selected ??= runs.find((r) => r.status === 'waiting_human')?.id
        ?? runs.find((r) => r.status === 'running')?.id
        ?? runs[0]?.id;

      const snap: Snapshot = { runs, pending };
      await this.post({ type: 'hydrate', ...snap, selected: this.selected });
      void this.loadInbox(false);

      if (this.selected) {
        const { events } = await this.client.getEvents(this.selected, 0);
        await this.post({ type: 'activity', runId: this.selected, events, reset: true });
      }
    } catch {
      await this.post({ type: 'disconnected' });
    }
  }

  /**
   * The work inbox (§6). Cache-first by default: `force` is only the refresh
   * button, so opening the panel never waits on two networks.
   */
  private async loadInbox(force: boolean): Promise<void> {
    try {
      const githubToken = await this.secrets.get(GITHUB_TOKEN_KEY);
      const raw = await this.secrets.get(JIRA_CREDS_KEY);
      const jira = raw ? (JSON.parse(raw) as { host?: string; email?: string; token?: string }) : undefined;

      const pullRequests = vscode.workspace
        .getConfiguration('agentflow.inbox')
        .get<'involves' | 'review-requested' | 'authored' | 'all'>('pullRequests', 'involves');

      const inbox = await this.client.workInbox({
        force,
        pullRequests,
        ...(githubToken ? { githubToken } : {}),
        ...(jira ? { jira } : {}),
      });
      await this.post({ type: 'inbox', inbox });
    } catch (err) {
      await this.post({
        type: 'inbox',
        inbox: {
          jira: { items: [], problem: err instanceof Error ? err.message : String(err) },
          github: { items: [] },
          stale: true,
        },
      });
    }
  }

  private enqueue(event: RunEvent): void {
    this.queue.push(event);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const events = this.queue;
      this.queue = [];
      void this.post({ type: 'activity', runId: this.selected, events, reset: false });
    }, 100);
  }

  private async post(message: unknown): Promise<void> {
    try {
      await this.panel.webview.postMessage(message);
    } catch { /* the panel is going away */ }
  }

  private dispose(): void {
    Dashboard.current = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.repaint) clearTimeout(this.repaint);
    for (const d of this.disposables) d.dispose();
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return DASHBOARD_HTML.replace(/__NONCE__/g, nonce);
  }
}

/** Approvals carry the gate; the webview renders them differently per gate. */
export type { ApprovalRequest };

/** Exported so the page can be rendered outside VS Code and looked at. */
export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-__NONCE__';">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
  }

  header {
    display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap;
    padding: 10px 18px; border-bottom: 1px solid var(--vscode-panel-border);
    flex: 0 0 auto;
  }
  header h1 { font-size: .95rem; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .counts { color: var(--vscode-descriptionForeground); font-size: .82rem; font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  button {
    font-family: inherit; font-size: .8rem; padding: 4px 11px; border-radius: 3px;
    border: 1px solid transparent; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.ghost {
    background: transparent; color: var(--vscode-foreground);
    border-color: var(--vscode-panel-border);
  }
  button.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-panel-border); }

  main { flex: 1; display: grid; grid-template-columns: minmax(0,1.35fr) minmax(300px,.65fr); overflow: hidden; }
  .col { overflow-y: auto; padding: 14px 18px; min-width: 0; }
  .col + .col { border-left: 1px solid var(--vscode-panel-border); }

  /* An editor tab is often split or in a narrow window. Two columns then
     squeeze the runs to nothing — the right column's minimum wins and the
     phase pills clip — so below this they stack and the page scrolls. */
  @media (max-width: 860px) {
    /* align-content matters here: without it the grid stretches its rows to
       fill the flex height, leaving a dead gap between the activity list and
       the decisions below it. */
    main { grid-template-columns: 1fr; overflow-y: auto; align-content: start; }
    .col { overflow-y: visible; }
    .col + .col { border-left: none; border-top: 1px solid var(--vscode-panel-border); }
  }
  h2 {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .09em;
    color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-weight: 600;
  }
  h2:not(:first-child) { margin-top: 22px; }

  /* --- run swimlanes ----------------------------------------------------- */
  .run {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    padding: 11px 13px; margin-bottom: 9px; cursor: pointer;
    background: var(--vscode-editorWidget-background);
  }
  .run:hover { border-color: var(--vscode-focusBorder); }
  .run.selected { border-color: var(--vscode-focusBorder); box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
  .run-top { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; flex-wrap: wrap; }
  .key { font-weight: 600; font-size: .88rem; }
  .summary {
    color: var(--vscode-descriptionForeground); font-size: .8rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1 1 140px; min-width: 0;
  }
  .meta { font-size: .74rem; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .status {
    font-size: .68rem; padding: 1px 7px; border-radius: 9px; white-space: nowrap;
    border: 1px solid currentColor; opacity: .95;
  }
  .status.running { color: var(--vscode-charts-blue); }
  .status.waiting_human { color: var(--vscode-charts-yellow); }
  .status.blocked, .status.failed { color: var(--vscode-errorForeground); }
  .status.succeeded { color: var(--vscode-charts-green); }
  .status.queued, .status.cancelled { color: var(--vscode-descriptionForeground); }

  .pipeline { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; }
  .phase {
    font-size: .68rem; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground);
  }
  .phase.done { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); opacity: .75; }
  .phase.current {
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-color: transparent; font-weight: 600;
  }
  .phase .step { opacity: .8; font-weight: 400; }
  .run-actions { display: flex; gap: 6px; margin-top: 10px; }

  /* --- needs you --------------------------------------------------------- */
  .card {
    border: 1px solid var(--vscode-panel-border); border-left-width: 3px;
    border-radius: 5px; padding: 10px 12px; margin-bottom: 9px;
    background: var(--vscode-editorWidget-background);
  }
  .card.gate { border-left-color: var(--vscode-charts-yellow); }
  .card.question { border-left-color: var(--vscode-charts-blue); }
  .card h3 { margin: 0 0 5px; font-size: .84rem; font-weight: 600; }
  .card p { margin: 0 0 8px; font-size: .79rem; color: var(--vscode-descriptionForeground); line-height: 1.45; }
  .checked { margin: 6px 0 8px; padding-left: 16px; font-size: .75rem; color: var(--vscode-descriptionForeground); }
  .checked li { margin: 2px 0; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }

  /* --- activity ---------------------------------------------------------- */
  #activity { font-size: .77rem; }
  .row { display: flex; gap: 9px; padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .row .t { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 46px; }
  .row .k { white-space: nowrap; min-width: 62px; color: var(--vscode-descriptionForeground); font-size: .72rem; }
  .row .d { flex: 1; word-break: break-word; }
  .ok { color: var(--vscode-testing-iconPassed); }
  .bad { color: var(--vscode-errorForeground); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  code { font-family: var(--vscode-editor-font-family); font-size: .95em; }

  .empty { color: var(--vscode-descriptionForeground); font-size: .82rem; padding: 10px 0; }

  /* --- work inbox -------------------------------------------------------- */
  .section-head { display: flex; align-items: baseline; gap: 8px; }
  .section-head h2 { margin-bottom: 10px; }
  .staleness { font-size: .68rem; color: var(--vscode-descriptionForeground); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .staleness.bad { color: var(--vscode-editorWarning-foreground); }
  .linkish {
    background: none; border: none; padding: 0; font-size: .68rem;
    color: var(--vscode-textLink-foreground); cursor: pointer; text-transform: none; letter-spacing: 0;
  }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .tab {
    background: none; border: 1px solid transparent; border-radius: 4px; padding: 3px 8px;
    font-family: inherit; font-size: .7rem; cursor: pointer;
    color: var(--vscode-descriptionForeground);
  }
  .tab:hover { background: var(--vscode-editorWidget-background); }
  .tab.on {
    color: var(--vscode-foreground); border-color: var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background);
  }
  .tab .n { opacity: .6; margin-left: 4px; }
  .item {
    display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-radius: 4px;
    border: 1px solid transparent; cursor: pointer;
    /* Wraps rather than pushing the action off the right edge: this column is
       narrow, and an action you cannot see is an action nobody uses. */
    flex-wrap: wrap;
  }
  .item:hover { border-color: var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
  .item .src {
    font-size: .62rem; padding: 1px 5px; border-radius: 3px; white-space: nowrap;
    border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground);
  }
  .item .ikey { font-weight: 600; font-size: .78rem; white-space: nowrap; }
  .item .ititle { flex: 1 1 120px; min-width: 0; font-size: .78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .istatus { font-size: .7rem; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  /* Always visible, not revealed on hover. Hover-only actions are invisible
     to anyone who does not already know they are there. */
  .item .go {
    font-size: .68rem; padding: 1px 7px; margin-left: auto;
    background: transparent; color: var(--vscode-textLink-foreground);
    border-color: var(--vscode-panel-border);
  }
  .item:hover .go { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .problem {
    font-size: .74rem; color: var(--vscode-editorWarning-foreground);
    padding: 6px 8px; line-height: 1.45;
  }
</style></head>
<body>
  <header>
    <h1>AgentFlow</h1>
    <span class="counts" id="counts"></span>
    <span class="spacer"></span>
    <button id="start">Start a run</button>
    <button class="ghost" id="reviewPr">Review a PR</button>
  </header>
  <main>
    <div class="col">
      <h2>Runs</h2>
      <div id="runs"></div>
      <h2>Activity</h2>
      <div id="activity"></div>
    </div>
    <div class="col">
      <h2>Needs you</h2>
      <div id="needs"></div>

      <div class="section-head">
        <h2>Your work</h2>
        <span class="staleness" id="staleness"></span>
        <span class="spacer"></span>
        <button class="linkish" id="refreshInbox">Refresh</button>
      </div>
      <div class="tabs" id="worktabs"></div>
      <div id="work"></div>
    </div>
  </main>

<script nonce="__NONCE__">
const vscode = acquireVsCodeApi();
const PHASES = ['intake','preflight','context','plan','build','review','ship'];

let state = vscode.getState() || {
  runs: [], pending: { questions: [], approvals: [] }, selected: null,
  inbox: { jira: { items: [] }, github: { items: [] }, stale: true },
  workTab: 'all',
};
let t0 = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

function elapsed(run) {
  const s = Math.max(0, Math.round((run.updatedAt - run.createdAt) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

function renderRuns() {
  const el = $('runs');
  if (!state.runs.length) {
    el.innerHTML = '<div class="empty">No runs yet. Start one, or review a pull request.</div>';
    return;
  }
  const order = ['waiting_human','running','blocked','queued','failed','succeeded','cancelled'];
  const runs = state.runs.slice().sort((a, b) =>
    (order.indexOf(a.status) - order.indexOf(b.status)) || (b.updatedAt - a.updatedAt));

  el.innerHTML = runs.map((r) => {
    const at = PHASES.indexOf(r.phase);
    const pipeline = PHASES.map((p, i) => {
      const cls = i === at ? 'current' : i < at ? 'done' : '';
      const step = (i === at && r.step) ? ' <span class="step">· ' + esc(r.step) + '</span>' : '';
      return '<span class="phase ' + cls + '">' + p + step + '</span>';
    }).join('');

    return '<div class="run ' + (r.id === state.selected ? 'selected' : '') + '" data-run="' + r.id + '">' +
      '<div class="run-top">' +
        '<span class="key">' + esc(r.ticket.key) + '</span>' +
        '<span class="summary">' + esc(r.ticket.summary) + '</span>' +
        '<span class="status ' + r.status + '">' + r.status.replace('_',' ') + '</span>' +
        '<span class="meta">' + elapsed(r) + ' · $' + r.cost.usd.toFixed(2) + '</span>' +
      '</div>' +
      '<div class="pipeline">' + pipeline + '</div>' +
      '<div class="run-actions">' +
        '<button class="ghost" data-detail="' + r.id + '">Timeline</button>' +
        (['succeeded','cancelled','failed'].includes(r.status) ? '' :
          '<button class="danger" data-cancel="' + r.id + '">Cancel</button>') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderNeeds() {
  const { approvals, questions } = state.pending;
  const el = $('needs');
  if (!approvals.length && !questions.length) {
    el.innerHTML = '<div class="empty">Nothing is waiting on you.</div>';
    return;
  }

  const gates = approvals.map((a) =>
    '<div class="card gate">' +
      '<h3>' + esc(a.gate) + ' · ' + esc(a.summary) + '</h3>' +
      '<p>$' + a.cost.soFarUsd.toFixed(2) + ' spent so far.</p>' +
      '<div class="actions">' +
        '<button data-decide="approve" data-a="' + a.id + '" data-r="' + a.runId + '" data-g="' + a.gate + '">Approve</button>' +
        '<button class="ghost" data-decide="revise" data-a="' + a.id + '" data-r="' + a.runId + '" data-g="' + a.gate + '">Request revision</button>' +
        '<button class="danger" data-decide="reject" data-a="' + a.id + '" data-r="' + a.runId + '" data-g="' + a.gate + '">Reject</button>' +
      '</div>' +
    '</div>').join('');

  const qs = questions.map(({ runId, question: q }) => {
    const opts = (q.options || []).map((o) =>
      '<button class="ghost" data-answer="' + esc(o.label) + '" data-q="' + q.id + '" data-r="' + runId + '" title="' + esc(o.implication) + '">' + esc(o.label) + '</button>').join('');
    // What it already checked is the thing that makes a question answerable
    // without going and looking (§9.2).
    const checked = (q.alreadyChecked || []).length
      ? '<ul class="checked">' + q.alreadyChecked.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '';
    return '<div class="card question">' +
      '<h3>' + esc(q.question) + '</h3>' +
      '<p>' + esc(q.whyItMatters) + '</p>' + checked +
      '<div class="actions">' + opts +
        '<button class="ghost" data-other="1" data-q="' + q.id + '" data-r="' + runId + '">Something else…</button>' +
        (q.blocking ? '' : '<button class="ghost" data-defer="1" data-q="' + q.id + '" data-r="' + runId + '">Defer</button>') +
      '</div>' +
    '</div>';
  }).join('');

  el.innerHTML = gates + qs;
}

function ago(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const m = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
}

/**
 * The tabs, keyed on Jira's own status categories.
 *
 * "All" stays first and is the default, so the merged list §6.1 asks for is
 * still what you land on — the tabs narrow it rather than replacing it.
 * "PRs" exists because a pull request has no Jira status and would otherwise
 * be reachable from no tab but "All".
 */
const WORK_TABS = [
  { id: 'all', label: 'All' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'development', label: 'Development' },
  { id: 'done', label: 'Done' },
  { id: 'prs', label: 'PRs' },
];

const TAB_CATEGORY = { backlog: 'new', development: 'indeterminate', done: 'done' };

function inTab(it, tab) {
  if (tab === 'all') return true;
  if (tab === 'prs') return it.source === 'github';
  return it.source === 'jira' && it.category === TAB_CATEGORY[tab];
}

function renderWork() {
  const inbox = state.inbox || { jira: { items: [] }, github: { items: [] }, stale: true };
  const all = [...(inbox.jira.items || []), ...(inbox.github.items || [])]
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

  const tab = state.workTab || 'all';
  const items = all.filter((it) => inTab(it, tab));

  $('worktabs').innerHTML = WORK_TABS.map((t) => {
    const n = all.filter((it) => inTab(it, t.id)).length;
    return '<button class="tab' + (t.id === tab ? ' on' : '') + '" data-worktab="' + t.id + '">' +
      t.label + '<span class="n">' + n + '</span></button>';
  }).join('');

  // Staleness rather than silence: "you have no work" and "I could not ask"
  // are different answers, and only one of them means you can stop looking.
  const fetched = Math.max(inbox.jira.fetchedAt || 0, inbox.github.fetchedAt || 0);
  const stale = $('staleness');
  if (!fetched) {
    stale.textContent = 'not fetched yet';
    stale.className = 'staleness';
  } else {
    const mins = Math.round((Date.now() - fetched) / 60000);
    stale.textContent = mins < 1 ? 'just now' : mins + 'm ago';
    stale.className = 'staleness' + (mins > 20 ? ' bad' : '');
  }

  const problems = [inbox.jira.problem, inbox.github.problem].filter(Boolean)
    .map((p) => '<div class="problem">' + esc(p) + '</div>').join('');

  const el = $('work');
  if (!items.length) {
    const empty = all.length
      ? 'Nothing in ' + (WORK_TABS.find((t) => t.id === tab) || {}).label + '.'
      : 'Nothing assigned to you, and no reviews waiting.';
    el.innerHTML = problems || '<div class="empty">' + empty + '</div>';
    return;
  }

  el.innerHTML = problems + items.map((it) => {
    const isTicket = it.source === 'jira';
    return '<div class="item" data-url="' + esc(it.url) + '">' +
      '<span class="src">' + (isTicket ? 'jira' : 'pr') + '</span>' +
      '<span class="ikey">' + esc(it.key) + '</span>' +
      '<span class="ititle">' + esc(it.title) + '</span>' +
      '<span class="istatus">' + esc(it.status) + (it.updatedAt ? ' · ' + ago(it.updatedAt) : '') + '</span>' +
      (isTicket
        ? '<button class="go ghost" data-startkey="' + esc(it.key) + '" data-starttitle="' + esc(it.title) + '">Plan</button>'
        : '<button class="go ghost" data-reviewpr="1">Review</button>') +
    '</div>';
  }).join('');
}

function renderCounts() {
  const runs = state.runs;
  const running = runs.filter((r) => r.status === 'running').length;
  const waiting = runs.filter((r) => r.status === 'waiting_human').length;
  const spend = runs.reduce((n, r) => n + r.cost.usd, 0);
  $('counts').textContent =
    running + ' running · ' + waiting + ' needs you · $' + spend.toFixed(2);
}

function describe(e) {
  switch (e.t) {
    case 'run_created': return ['run', 'created on <code>' + esc(e.branch) + '</code>'];
    case 'phase_entered': return ['phase', '→ <b>' + esc(e.phase) + '</b>'];
    case 'step_entered': return ['step', '· ' + esc(e.step)];
    case 'status_changed': return ['status', esc(e.status) + (e.reason ? ' — ' + esc(e.reason) : '')];
    case 'artifact_written': return ['artifact', esc(e.kind) + '.v' + e.version];
    case 'question_asked': return ['question', '<span class="warn">' + esc(e.question.question) + '</span>'];
    case 'question_answered': return ['answered', esc(e.questionId)];
    case 'approval_requested': return ['gate', '<b>' + esc(e.gate) + '</b> awaiting a decision'];
    case 'approval_decided': return ['gate', '<b>' + esc(e.gate) + '</b> ' + esc(e.decision)];
    case 'task_status': return ['task', esc(e.taskId) + ' → ' + esc(e.status)];
    case 'tool_call': return ['tool', '<code>' + esc(e.tool) + '</code>'];
    case 'tool_result': return ['result', (e.ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + esc(e.summaryLine)];
    case 'file_changed': return ['file', esc(e.op) + ' <code>' + esc(e.path) + '</code>'];
    case 'checkpoint': return ['checkpoint', esc(e.label)];
    case 'gate_result': return ['gate', esc(e.gate) + (e.ok ? ' <span class="ok">passed</span>' : ' <span class="bad">failed</span>') + ' in ' + e.durationMs + 'ms'];
    case 'cost': return ['cost', '$' + e.usd.toFixed(3) + ' · ' + esc(e.model)];
    case 'log': return [e.level === 'warn' ? 'warn' : 'log', (e.level === 'warn' ? '<span class="warn">' + esc(e.message) + '</span>' : esc(e.message))];
    case 'error': return ['error', '<span class="bad">' + esc(e.message) + '</span>'];
    default: return [esc(e.t), ''];
  }
}

function appendActivity(events, reset) {
  const el = $('activity');
  if (reset) { el.innerHTML = ''; t0 = null; }
  if (!events.length && reset) {
    el.innerHTML = '<div class="empty">Select a run to watch it.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of events) {
    if (t0 === null) t0 = e.at;
    const [kind, detail] = describe(e);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="t">+' + ((e.at - t0) / 1000).toFixed(1) + 's</span>' +
      '<span class="k">' + kind + '</span><span class="d">' + detail + '</span>';
    frag.appendChild(row);
  }
  el.appendChild(frag);
  // Only follow the tail when already near it, so reading history is not
  // yanked away by a run that is still going.
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (near) el.scrollTop = el.scrollHeight;
}

function renderAll() {
  renderCounts(); renderRuns(); renderNeeds(); renderWork();
  vscode.setState(state);
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('button') || ev.target.closest('.run');
  if (!t) return;
  const d = t.dataset || {};

  if (t.id === 'start') return send('start');
  if (t.id === 'reviewPr') return send('reviewPr');
  if (t.id === 'refreshInbox') { $('staleness').textContent = 'refreshing…'; return send('refreshInbox'); }
  if (d.worktab) { state.workTab = d.worktab; vscode.setState(state); return renderWork(); }
  if (d.startkey) {
    ev.stopPropagation();
    // The body comes from the item rather than the button: it is prose, and
    // a data- attribute would mean escaping a paragraph into markup.
    const it = (state.inbox.jira.items || []).find((x) => x.key === d.startkey) || {};
    return send('startFromItem', {
      key: d.startkey, title: d.starttitle,
      description: it.description || '', labels: it.labels || [],
    });
  }
  if (d.reviewpr) { ev.stopPropagation(); return send('reviewPr'); }
  if (t.dataset.url) return send('openItem', { url: t.dataset.url });
  if (d.detail) { ev.stopPropagation(); return send('openDetail', { runId: d.detail }); }
  if (d.cancel) { ev.stopPropagation(); return send('cancel', { runId: d.cancel }); }
  if (d.decide) return send('decide', { decision: d.decide, approvalId: d.a, runId: d.r, gate: d.g });
  if (d.answer !== undefined) return send('answer', { choice: d.answer, questionId: d.q, runId: d.r });
  if (d.other) return send('answerOther', { questionId: d.q, runId: d.r });
  if (d.defer) return send('answer', { deferred: true, questionId: d.q, runId: d.r });
  if (t.dataset.run) { state.selected = t.dataset.run; renderAll(); return send('select', { runId: t.dataset.run }); }
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'hydrate') {
    state = { runs: m.runs, pending: m.pending, selected: m.selected ?? state.selected };
    renderAll();
  } else if (m.type === 'pending') {
    state.pending = m.pending; renderNeeds(); vscode.setState(state);
  } else if (m.type === 'inbox') {
    state.inbox = m.inbox; renderWork(); vscode.setState(state);
  } else if (m.type === 'activity') {
    appendActivity(m.events || [], m.reset);
  } else if (m.type === 'disconnected') {
    $('counts').textContent = 'orchestrator not connected';
  }
});

renderAll();
send('ready');
</script>
</body></html>`;
