import type { Plan, Spec } from '@agentflow/agent-runtime';
import type { ReplayState } from '@agentflow/core';
import type { Run } from '@agentflow/protocol';
import type { CommitSummary } from '../git/worktree.js';

/**
 * The §5.8 hand-off package: everything a human needs to push this branch and
 * open the PR themselves, written to disk and nothing else. Nothing here
 * leaves the machine — the push is the first irreversible, externally visible
 * step in the pipeline and it stays a human action by default.
 *
 * The "how to verify manually" section is the part that earns the file. Gate
 * output proves the code does what the tests say; it cannot prove the tests
 * say the right thing, so the reviewer is handed the acceptance criteria in
 * the words the ticket used.
 */

export interface PrPackageInput {
  run: Run;
  spec?: Spec | undefined;
  plan?: Plan | undefined;
  commits: readonly CommitSummary[];
  diffstat: string;
  gates: ReplayState['gateResults'];
  baseSha: string;
}

export function prPackage(input: PrPackageInput): string {
  const { run, spec, plan, commits, diffstat, gates, baseSha } = input;
  const out: string[] = [];

  out.push(`# ${title(run, spec)}`, '');
  out.push(
    '> Prepared by AgentFlow. Nothing has been pushed — this is a hand-off, not a PR.',
    '',
    `- **Branch:** \`${run.branch}\``,
    `- **Base:** \`${run.repo.baseRef}\` at \`${baseSha.slice(0, 12)}\``,
    `- **Ticket:** ${run.ticket.url ?? run.ticket.key}`,
    `- **Workflow:** \`${run.workflow}\``,
    `- **Cost:** $${run.cost.usd.toFixed(2)}`,
    '',
  );

  out.push('## What changed', '');
  out.push(spec?.problem ?? run.ticket.summary, '');
  if (plan?.strategy) out.push('### Approach', '', plan.strategy, '');

  if (spec && spec.outOfScope.length > 0) {
    out.push('### Deliberately out of scope', '');
    for (const item of spec.outOfScope) out.push(`- ${item}`);
    out.push('');
  }

  out.push('## Commits', '');
  for (const c of commits) out.push(`- \`${c.sha.slice(0, 9)}\` ${c.subject}`);
  out.push('');

  if (diffstat) out.push('## Diffstat', '', '```', diffstat, '```', '');

  out.push('## Gates', '');
  if (gates.length === 0) {
    out.push('_No gate ran, which is not a pass. Do not merge this._', '');
  } else {
    out.push('| Gate | Result | Duration |', '|---|---|---|');
    // The last result per gate is the one that counts: an earlier red that a
    // repair fixed is history, and the ship-time re-run is the current truth.
    for (const [gate, r] of latestPerGate(gates)) {
      out.push(`| \`${gate}\` | ${r.ok ? 'passed' : '**FAILED**'} | ${r.durationMs}ms |`);
    }
    out.push('');
  }

  out.push('## How to verify manually', '');
  const criteria = spec?.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    out.push('_The spec recorded no acceptance criteria._', '');
  } else {
    for (const ac of criteria) out.push(`- [ ] **${ac.id}** ${ac.statement}`);
    out.push('');
  }

  if (spec && spec.assumptions.length > 0) {
    out.push('## Assumptions made', '', 'Worth a glance: each of these could be wrong.', '');
    for (const a of spec.assumptions) {
      out.push(`- **${a.id}** ${a.statement} _(confidence ${a.confidence}, impact if wrong: ${a.impactIfWrong})_`);
    }
    out.push('');
  }

  if (spec?.rollback) out.push('## Rollback', '', spec.rollback, '');

  out.push('## To land this', '', '```bash', `git push -u origin ${run.branch}`, '```', '');
  out.push(
    `Then open the PR with the body above, and move ${run.ticket.key} yourself.`,
    'AgentFlow does neither by default (§5.8).',
    '',
  );

  return out.join('\n');
}

/**
 * The ticket summary first, not the spec's problem statement. The problem
 * statement describes what is wrong; a PR title should say what the change
 * does, and the summary is already a human's name for the work.
 */
function title(run: Run, spec?: Spec): string {
  const summary = run.ticket.summary.trim()
    || spec?.problem?.split(/(?<=[.!?])\s/)[0]
    || run.ticket.key;
  const trimmed = summary.length > 72 ? `${summary.slice(0, 69).trimEnd()}…` : summary;
  return `${run.ticket.key}: ${trimmed}`;
}

function latestPerGate(gates: ReplayState['gateResults']): [string, ReplayState['gateResults'][number]][] {
  const latest = new Map<string, ReplayState['gateResults'][number]>();
  for (const r of gates) latest.set(r.gate, r);
  return [...latest];
}
