import { describe, expect, it } from 'vitest';
import type { Run } from '@agentflow/protocol';
import { prPackage, type PrPackageInput } from './prPackage.js';

/**
 * The hand-off package is the run's deliverable (§5.8). What it must never do
 * is imply an action the tool did not take, or present a gate that never ran
 * as evidence of anything.
 */

const run: Run = {
  id: '11111111-1111-4111-8111-111111111111',
  ticket: { key: 'PAY-1423', summary: 'Checkout empty state', profile: 'feature', tracker: 'manual' },
  repo: { id: 'default', path: '/repo', baseRef: 'origin/main' },
  worktree: '/repo-agentflow/PAY-1423',
  branch: 'agentflow/PAY-1423',
  workflow: 'feature',
  phase: 'ship',
  step: 'rebase',
  status: 'running',
  attemptBudget: { perTask: 4, perRun: 12, maxUsd: 8, maxWallClockMin: 90 },
  cost: { usd: 1.54, inputTokens: 0, outputTokens: 0 },
  createdAt: 1,
  updatedAt: 2,
  artifacts: {},
  sessions: {},
  tasks: [],
};

const input = (over: Partial<PrPackageInput> = {}): PrPackageInput => ({
  run,
  commits: [{ sha: 'a'.repeat(40), subject: 'PAY-1423: render the empty state' }],
  diffstat: ' src/EmptyState.tsx | 12 ++++++++++++\n 1 file changed, 12 insertions(+)',
  gates: [{ gate: 'unit', ok: true, durationMs: 4200, signature: 'sig' }],
  baseSha: 'b'.repeat(40),
  ...over,
});

describe('the hand-off package', () => {
  it('says plainly that nothing was pushed', () => {
    const md = prPackage(input());
    expect(md).toContain('Nothing has been pushed');
    expect(md).toContain('git push -u origin agentflow/PAY-1423');
  });

  it('carries the branch, base and ticket a human needs to push it', () => {
    const md = prPackage(input());
    expect(md).toContain('`agentflow/PAY-1423`');
    expect(md).toContain('`origin/main`');
    expect(md).toContain('bbbbbbbbbbbb');
    expect(md).toContain('PAY-1423');
  });

  it('lists every commit', () => {
    const md = prPackage(input({
      commits: [
        { sha: 'a'.repeat(40), subject: 'PAY-1423: second' },
        { sha: 'c'.repeat(40), subject: 'PAY-1423: first' },
      ],
    }));
    expect(md).toContain('PAY-1423: second');
    expect(md).toContain('PAY-1423: first');
  });

  it('refuses to present a gateless run as verified', () => {
    const md = prPackage(input({ gates: [] }));
    expect(md).toContain('No gate ran, which is not a pass');
    expect(md).toContain('Do not merge this');
  });

  it('shows a failed gate as failed rather than burying it', () => {
    const md = prPackage(input({
      gates: [{ gate: 'unit', ok: false, durationMs: 900, signature: 'sig' }],
    }));
    expect(md).toContain('**FAILED**');
  });

  it('reports the last result per gate, not an earlier red a repair fixed', () => {
    const md = prPackage(input({
      gates: [
        { gate: 'unit', ok: false, durationMs: 900, signature: 'a' },
        { gate: 'unit', ok: true, durationMs: 4200, signature: 'b' },
      ],
    }));
    expect(md).not.toContain('**FAILED**');
    expect(md).toContain('4200ms');
  });

  it('hands over the acceptance criteria as a manual checklist', () => {
    const md = prPackage(input({
      spec: {
        problem: 'The cart shows a blank panel when empty.',
        inScope: [], outOfScope: ['Recommendations carousel'],
        acceptanceCriteria: [
          { id: 'AC1', statement: 'An empty cart renders the empty state', source: { quote: 'q' } },
        ],
        assumptions: [
          { id: 'A1', statement: 'The existing flag gates this', confidence: 0.6, impactIfWrong: 'high' },
        ],
        openQuestions: [],
        rollback: 'Disable the flag.',
      } as unknown as PrPackageInput['spec'],
    }));
    // Gate output proves the code matches the tests; it cannot prove the tests
    // match the ticket, so the criteria go to the human in the ticket's words.
    expect(md).toContain('- [ ] **AC1** An empty cart renders the empty state');
    expect(md).toContain('Recommendations carousel');
    expect(md).toContain('A1');
    expect(md).toContain('impact if wrong: high');
    expect(md).toContain('Disable the flag.');
  });

  it('says so when the spec recorded no criteria, rather than leaving a blank', () => {
    expect(prPackage(input())).toContain('The spec recorded no acceptance criteria');
  });

  it('titles the PR with the ticket summary, not the problem statement', () => {
    const md = prPackage(input({
      spec: {
        problem: 'The cart shows a blank panel when empty, which reads as a bug.',
        inScope: [], outOfScope: [], acceptanceCriteria: [], assumptions: [], openQuestions: [],
      } as unknown as PrPackageInput['spec'],
    }));
    // The problem statement says what is wrong; a PR title says what changed.
    expect(md.split('\n')[0]).toBe('# PAY-1423: Checkout empty state');
  });

  it('trims an over-long title rather than emitting a paragraph', () => {
    const md = prPackage(input({
      run: { ...run, ticket: { ...run.ticket, summary: 'x'.repeat(200) } },
    }));
    const title = md.split('\n')[0]!;
    expect(title.startsWith('# PAY-1423: ')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title).toContain('…');
  });
});
