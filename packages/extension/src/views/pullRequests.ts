import * as vscode from 'vscode';
import type { ListPullRequestsResult, PrLabelFilter } from '@agentflow/protocol';
import type { OrchestratorClient } from '../client/orchestratorClient.js';

/**
 * Choosing a pull request to review (§6.1, §7).
 *
 * The label filter is the first question rather than a refinement of the
 * results, because "tagged `needs-review`" and "carrying no labels at all"
 * are how a review queue is actually looked at — the second is the untriaged
 * pile, and filtering a list of everything would never surface it.
 */

export const GITHUB_TOKEN_KEY = 'agentflow.githubToken';

type FilterChoice = vscode.QuickPickItem & { filter?: PrLabelFilter; pickLabels?: boolean };

export async function pickLabelFilter(
  client: OrchestratorClient,
  secrets: vscode.SecretStorage,
): Promise<PrLabelFilter | undefined> {
  const choice = await vscode.window.showQuickPick<FilterChoice>(
    [
      { label: '$(git-pull-request) All open pull requests', filter: { kind: 'any' } },
      {
        label: '$(tag) Tagged…',
        description: 'pick one or more labels',
        pickLabels: true,
      },
      {
        label: '$(circle-outline) Untagged',
        description: 'carrying no labels at all — the untriaged pile',
        filter: { kind: 'untagged' },
      },
    ],
    { title: 'Review a pull request', placeHolder: 'Which pull requests?' },
  );
  if (!choice) return undefined;
  if (!choice.pickLabels) return choice.filter;

  const token = await secrets.get(GITHUB_TOKEN_KEY);
  const { labels, problem } = await client.listLabels({ ...(token ? { token } : {}) });
  if (problem) {
    void vscode.window.showWarningMessage(`AgentFlow: ${problem}`);
    return undefined;
  }
  if (labels.length === 0) {
    void vscode.window.showInformationMessage('AgentFlow: this repository has no labels.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(labels, {
    canPickMany: true,
    title: 'Tagged with',
    placeHolder: 'A pull request must carry every label you pick',
  });
  if (!picked || picked.length === 0) return undefined;
  return { kind: 'tagged', labels: picked };
}

type PrItem = vscode.QuickPickItem & { number?: number };

/** Show the matching PRs and return the one chosen. */
export async function pickPullRequest(
  client: OrchestratorClient,
  secrets: vscode.SecretStorage,
  filter: PrLabelFilter,
): Promise<{ number: number; title: string } | undefined> {
  const token = await secrets.get(GITHUB_TOKEN_KEY);

  const result = await vscode.window.withProgress<ListPullRequestsResult>(
    { location: vscode.ProgressLocation.Notification, title: 'AgentFlow: fetching pull requests…' },
    () => client.listPullRequests({
      labels: filter,
      state: 'open',
      reviewRequested: false,
      limit: 50,
      ...(token ? { token } : {}),
    }),
  );

  if (result.problem) {
    // The daemon returns the problem rather than throwing precisely so it can
    // be shown with the fix in it, not as a stack trace.
    void vscode.window.showErrorMessage(`AgentFlow: ${result.problem}`);
    return undefined;
  }
  if (result.pullRequests.length === 0) {
    void vscode.window.showInformationMessage(
      `AgentFlow: no open pull requests ${describe(filter)}.`,
    );
    return undefined;
  }

  const items: PrItem[] = result.pullRequests.map((pr) => ({
    label: `$(git-pull-request) #${pr.number} ${pr.title}`,
    description: pr.labels.length > 0 ? pr.labels.join(', ') : 'no labels',
    detail: `${pr.author}${pr.draft ? ' · draft' : ''} · updated ${ago(pr.updatedAt)}`,
    number: pr.number,
  }));

  const chosen = await vscode.window.showQuickPick(items, {
    title: `Pull requests ${describe(filter)}`,
    placeHolder: 'Pick one to review',
    matchOnDescription: true,
  });
  if (!chosen?.number) return undefined;

  const pr = result.pullRequests.find((p) => p.number === chosen.number)!;
  return { number: pr.number, title: pr.title };
}

function describe(filter: PrLabelFilter): string {
  if (filter.kind === 'untagged') return 'carrying no labels';
  if (filter.kind === 'tagged') return `tagged ${filter.labels.join(' + ')}`;
  return 'in this repository';
}

function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
