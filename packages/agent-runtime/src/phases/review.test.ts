import { describe, expect, it } from 'vitest';
import type { ResolvedWorkflow } from '@agentflow/protocol';
import type { AgentProvider, AgentSession, AgentTurn, SessionOptions } from '../providers/types.js';
import type { Plan } from './plan.js';
import {
  SYCOPHANCY_LINE_THRESHOLD, blockingCount, changedLineCount, runReview, unplannedFiles,
  type ReviewFinding, type ReviewReport,
} from './review.js';

/**
 * The reviewer's job is the gap the gates cannot close: the gates prove the
 * code does what its tests say, not that the tests say the right thing.
 */

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'F1', severity: 'major', category: 'correctness',
  file: 'src/cart.ts', line: 12, title: 'Total ignores the discount',
  evidence: 'the added branch returns before applying discount',
  suggestedFix: 'apply the discount before returning',
  confidence: 0.8,
  ...over,
});

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  findings: [],
  planConformance: { verdict: 'conforms', notes: 'matches the approved plan', unjustifiedFiles: [] },
  summary: 'The change does what the specification asked for.',
  ...over,
});

const workflow = {
  agents: { reviewer: { model: 'opus', effort: 'xhigh', thinking: 'adaptive' } },
  guardrails: { forbiddenPaths: [] },
  budgets: { perRunUsd: 6 },
} as unknown as ResolvedWorkflow;

/** Returns a scripted report per call, and records how it was configured. */
function provider(reports: ReviewReport[]): AgentProvider & { seen: SessionOptions[] } {
  const seen: SessionOptions[] = [];
  const p = {
    id: 'stub',
    capabilities: () => ({
      hooks: true, subagents: false, structuredOutput: true, checkpointing: false, permissions: true,
    }),
    supportedModels: async () => ['opus'],
    createSession: async (opts: SessionOptions): Promise<AgentSession> => {
      seen.push(opts);
      return {
        id: `s${seen.length}`,
        async *send(): AsyncIterable<AgentTurn> {
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, usd: 0.5 } };
          yield { type: 'done', result: reports[seen.length - 1] ?? reports.at(-1) };
        },
        interrupt: async () => {},
        close: async () => {},
      };
    },
  } as unknown as AgentProvider & { seen: SessionOptions[] };
  p.seen = seen;
  return p;
}

const input = (over: Record<string, unknown> = {}) => ({
  ticketKey: 'PAY-1', diff: '+++ b/src/cart.ts\n+const a = 1;\n-const b = 2;\n',
  changedFiles: ['src/cart.ts'], gateReports: [], worktree: '/wt', workflow,
  ...over,
} as Parameters<typeof runReview>[1]);

describe('REVIEW_CLEAR (§5.7)', () => {
  it('counts only blocker and major as blocking', () => {
    expect(blockingCount([
      finding({ severity: 'blocker' }), finding({ severity: 'major' }),
      finding({ severity: 'minor' }), finding({ severity: 'nit' }),
    ])).toBe(2);
  });

  it('lets minor and nit through — they inform without stopping the run', () => {
    expect(blockingCount([finding({ severity: 'minor' }), finding({ severity: 'nit' })])).toBe(0);
  });
});

describe('plan conformance is computed, not asked', () => {
  const plan = { tasks: [{ files: ['src/cart.ts', 'src/total.ts'] }] } as unknown as Plan;

  it('names files no task predicted', () => {
    // A model asked to do set comparison over a long list gets it wrong
    // occasionally, and in the direction that produces no finding.
    expect(unplannedFiles(['src/cart.ts', 'src/secret.ts'], plan)).toEqual(['src/secret.ts']);
  });

  it('reports nothing when every change was planned', () => {
    expect(unplannedFiles(['src/cart.ts'], plan)).toEqual([]);
  });

  it('claims nothing when there is no plan to compare against', () => {
    expect(unplannedFiles(['src/cart.ts'], undefined)).toEqual([]);
  });
});

describe('anti-sycophancy (§5.7)', () => {
  const bigDiff = ['+++ b/a.ts', ...Array.from({ length: 200 }, (_, i) => `+line ${i}`)].join('\n');

  it('counts changed lines without counting the file headers', () => {
    expect(changedLineCount('+++ b/a.ts\n--- a/a.ts\n+added\n-removed\n unchanged\n')).toBe(2);
  });

  it('re-reviews adversarially when a large diff comes back empty', async () => {
    const found = report({ findings: [finding()] });
    const p = provider([report(), found]);
    const r = await runReview(p, input({ diff: bigDiff }));

    expect(r.adversarialUsed).toBe(true);
    expect(r.blocking).toBe(1);
    // A second session, not a continuation of the first.
    expect(p.seen).toHaveLength(2);
    expect(r.usd).toBe(1);
  });

  it('accepts an empty second pass — a fabricated finding is worse than none', async () => {
    const p = provider([report(), report()]);
    const r = await runReview(p, input({ diff: bigDiff }));

    expect(r.adversarialUsed).toBe(true);
    expect(r.blocking).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('does not re-review a small diff that came back empty', async () => {
    const p = provider([report()]);
    const r = await runReview(p, input());

    expect(changedLineCount(input().diff)).toBeLessThan(SYCOPHANCY_LINE_THRESHOLD);
    expect(r.adversarialUsed).toBe(false);
    expect(p.seen).toHaveLength(1);
  });

  it('does not re-review a large diff that already found something', async () => {
    const p = provider([report({ findings: [finding({ severity: 'nit' })] })]);
    const r = await runReview(p, input({ diff: bigDiff }));

    expect(r.adversarialUsed).toBe(false);
    expect(p.seen).toHaveLength(1);
  });

  it('keeps the empty result but reports that the second look failed', async () => {
    // An unusable re-review is not evidence of a problem, and it does not
    // promote the empty first pass to trustworthy either.
    const p = provider([report(), { nonsense: true } as unknown as ReviewReport]);
    const r = await runReview(p, input({ diff: bigDiff }));

    expect(r.blocking).toBe(0);
    expect(r.adversarialUsed).toBe(false);
    expect(r.error).toMatch(/adversarial re-review failed/);
  });
});

describe('the review session is cold and read-only', () => {
  it('cannot write, so it reviews the change that was made', async () => {
    const p = provider([report()]);
    await runReview(p, input());

    // An empty allowlist puts the session in plan mode. A reviewer that
    // "helpfully" fixes what it finds is no longer reviewing the same change.
    expect(p.seen[0]!.guardrails.allowedPaths).toEqual([]);
    expect(p.seen[0]!.guardrails.maxFilesTouched).toBe(0);
    expect(p.seen[0]!.role).toBe('reviewer');
  });

  it('never resumes or forks another session', async () => {
    const p = provider([report()]);
    await runReview(p, input());

    // Inheriting the implementer's context inherits its blind spots.
    expect(p.seen[0]!.resume).toBeUndefined();
    expect(p.seen[0]!.fork).toBeUndefined();
  });

  it('fails rather than returning an empty review it could not produce', async () => {
    const p = provider([{ findings: 'not an array' } as unknown as ReviewReport]);
    const r = await runReview(p, input());

    // Handing the human an empty findings list would read as "nothing wrong"
    // rather than "nobody looked".
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema/);
  });
});
