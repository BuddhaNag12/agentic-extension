import { z } from 'zod';
import type { GateReport, ResolvedWorkflow } from '@agentflow/protocol';
import { composePrompt } from '../prompts/compose.js';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { Plan } from './plan.js';
import type { Spec } from './spec.js';

/**
 * Phase 6 — Review (§5.7). The cold read.
 *
 * The session is **fresh**: it sees the spec, the approved plan, the diff and
 * the gate reports, and nothing of the implementer's reasoning. A reviewer that
 * inherits the implementer's context inherits its blind spots and tends to
 * ratify — which is the failure mode that makes an automated review worse than
 * none, because it launders a bad change as a reviewed one.
 *
 * M2 asks for a single pass. §5.7's four narrow subagents are M5.
 */

/** Distinct from the guardrails' `Finding`, which is an anti-pattern hit. */
export const Severity = z.enum(['blocker', 'major', 'minor', 'nit']);
export type Severity = z.infer<typeof Severity>;

export const ReviewFinding = z.object({
  id: z.string(),
  severity: Severity,
  category: z.enum(['correctness', 'conformance', 'security', 'maintainability']),
  file: z.string(),
  line: z.number().int().positive().optional(),
  title: z.string().min(8).max(120),
  /** What in the diff shows this. A finding without evidence is an opinion. */
  evidence: z.string().min(10),
  suggestedFix: z.string().min(5),
  confidence: z.number().min(0).max(1),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewReport = z.object({
  findings: z.array(ReviewFinding),
  planConformance: z.object({
    verdict: z.enum(['conforms', 'deviates', 'unclear']),
    /** Why the deviation is or is not acceptable — the mechanical detection of
     *  *which* files are unplanned is done in code and handed to the model. */
    notes: z.string().min(10),
    unjustifiedFiles: z.array(z.string()),
  }),
  /** Reviewer's own summary. Evidence for the human, never a verdict (§1.4). */
  summary: z.string().min(20),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

export interface ReviewInput {
  ticketKey: string;
  spec?: Spec | undefined;
  plan?: Plan | undefined;
  diff: string;
  diffTruncated?: boolean;
  changedFiles: readonly string[];
  gateReports: readonly GateReport[];
  worktree: string;
  workflow: ResolvedWorkflow;
  /**
   * What a pull request *claims* to do — its title and description (§7.4).
   * Present only for a review pipeline; a deliver run has a spec instead.
   */
  claim?: { title: string; body: string } | undefined;
  /** Set on the second pass; see `adversarialReview`. */
  adversarial?: boolean;
}

export interface ReviewResult {
  ok: boolean;
  report?: ReviewReport;
  /** Blocking findings, by §5.7's REVIEW_CLEAR definition. */
  blocking: number;
  /** Files changed that no task predicted. Computed, not asked. */
  unplannedFiles: string[];
  adversarialUsed: boolean;
  error?: string;
  usd: number;
}

/**
 * §5.7's REVIEW_CLEAR: zero unresolved blocker or major. Minor and nit reach
 * the human without stopping the run.
 */
export function blockingCount(findings: readonly ReviewFinding[]): number {
  return findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').length;
}

/**
 * Files the diff touched that no task predicted (§5.7 conformance).
 *
 * Computed rather than asked. Whether a file was in the plan is a set
 * comparison, and a model asked to do set comparison over a long list will
 * occasionally get it wrong in the direction that produces no finding.
 */
export function unplannedFiles(
  changed: readonly string[],
  plan: Plan | undefined,
): string[] {
  if (!plan) return [];
  const predicted = new Set(plan.tasks.flatMap((t) => t.files));
  return changed.filter((f) => !predicted.has(f));
}

/** Diffs bigger than this with zero findings get a second, adversarial look. */
export const SYCOPHANCY_LINE_THRESHOLD = 150;

export function changedLineCount(patch: string): number {
  let n = 0;
  for (const line of patch.split('\n')) {
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      n += 1;
    }
  }
  return n;
}

const BRIEF = `
Review this change as if you had never seen it before, because you have not.

You are given the specification, the approved plan, the diff and the gate
results. You were not told how the change was arrived at, and you should not
speculate about it — judge the diff.

The gates already proved the code does what its tests say. They cannot prove the
tests say the right thing, that the change matches what was asked for, or that
it is safe. That gap is what you are for.

Every finding needs evidence from the diff and a concrete suggested fix. A
finding you cannot point at is an opinion, and opinions cost the human the
attention that real findings need.

Severity means what it says:
- blocker: this is wrong and must not merge.
- major: this is wrong or unsafe in a way a reviewer would refuse.
- minor: worth fixing, would not block.
- nit: taste.

Only blocker and major stop the run, so do not inflate, and do not deflate
either — a blocker filed as a nit is how a bad change merges.

Return JSON matching the schema you were given. Nothing else.
`.trim();

/** §7.4, the pass unique to reviewing someone else's pull request. */
const CLAIM_CONFORMANCE = `
This is an inbound pull request, so there is no specification — what it claims
is its title and description. Check the claim against the diff:

- Something the description promises that the diff does not contain.
- Substantive changes the description does not mention. Scale the severity by
  risk: a refactor buried in a bugfix PR is exactly what you are here to catch.
- Unrelated churn — formatting, IDE config, version bumps — grouped into **one**
  \`nit\`, never one per file.

File these as \`conformance\`.
`.trim();

const ADVERSARIAL = `
A first pass over this diff returned **no findings at all**, on a change large
enough that this is unlikely.

Assume the first pass was wrong and look for what it would have missed: an
untested edge, an error path that swallows, an assumption about input that the
diff does not check, a test that asserts nothing meaningful, a behaviour change
the specification did not ask for.

If the change really is clean, say so and return no findings — a fabricated
finding is worse than none. But do not return empty because it is easier.
`.trim();

export async function runReview(
  provider: AgentProvider,
  input: ReviewInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<ReviewResult> {
  const unplanned = unplannedFiles(input.changedFiles, input.plan);

  const first = await onePass(provider, input, unplanned, onTurn);
  if (!first.ok || !first.report) return { ...first, unplannedFiles: unplanned, adversarialUsed: false };

  // §5.7's anti-sycophancy rule. One re-review, not a loop: the point is to
  // catch a reflexive pass, not to argue the reviewer into finding something.
  const big = changedLineCount(input.diff) > SYCOPHANCY_LINE_THRESHOLD;
  if (first.report.findings.length === 0 && big) {
    const second = await onePass(provider, { ...input, adversarial: true }, unplanned, onTurn);
    if (second.ok && second.report) {
      return {
        ok: true,
        report: second.report,
        blocking: blockingCount(second.report.findings),
        unplannedFiles: unplanned,
        adversarialUsed: true,
        usd: first.usd + second.usd,
      };
    }
    // A failed re-review does not promote the empty first pass to trustworthy,
    // but it is also not evidence of a problem. The empty result stands, and
    // the caller is told the check could not complete.
    return {
      ...first,
      unplannedFiles: unplanned,
      adversarialUsed: false,
      usd: first.usd + second.usd,
      error: `adversarial re-review failed: ${second.error ?? 'unknown'}`,
    };
  }

  return {
    ok: true,
    report: first.report,
    blocking: blockingCount(first.report.findings),
    unplannedFiles: unplanned,
    adversarialUsed: false,
    usd: first.usd,
  };
}

async function onePass(
  provider: AgentProvider,
  input: ReviewInput,
  unplanned: readonly string[],
  onTurn?: (turn: AgentTurn) => void,
): Promise<{ ok: boolean; report?: ReviewReport; blocking: number; error?: string; usd: number }> {
  const binding = input.workflow.agents.reviewer
    ?? { model: 'opus' as const, effort: 'xhigh' as const, thinking: 'adaptive' as const };

  const prompt = composePrompt({
    role: 'reviewer',
    workflow: input.workflow,
    phaseBrief: [BRIEF, input.claim ? CLAIM_CONFORMANCE : '', input.adversarial ? ADVERSARIAL : '']
      .filter(Boolean).join('\n\n'),
    gates: input.gateReports.map((g) => g.gate),
    // Read-only: an empty allowlist puts the session in plan mode, so the
    // reviewer cannot "helpfully" fix what it finds. A reviewer that edits is
    // no longer reviewing the change that was made.
    allowedPaths: [],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    questionsRemaining: 0,
  });

  const opts: SessionOptions = {
    role: 'reviewer',
    model: binding.model,
    effort: binding.effort,
    thinking: binding.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: binding.maxTurns ?? 40,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 3,
    outputSchema: z.toJSONSchema(ReviewReport),
    guardrails: {
      worktree: input.worktree,
      allowedPaths: [],
      forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
      maxFilesTouched: 0,
      filesTouched: new Set<string>(),
      allowDependencyChanges: false,
      failingTestFiles: [],
    },
  };

  const session = await provider.createSession(opts);
  let usd = 0;
  let raw: unknown;
  let error: string | undefined;

  try {
    for await (const turn of session.send(reviewPrompt(input, unplanned))) {
      onTurn?.(turn);
      if (turn.type === 'usage') usd += turn.usage?.usd ?? 0;
      if (turn.type === 'done') raw = turn.result;
      if (turn.type === 'error') error = turn.error;
    }
  } finally {
    await session.close();
  }

  if (error) return { ok: false, blocking: 0, error, usd };

  const parsed = ReviewReport.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, blocking: 0, usd,
      error: `review did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  return { ok: true, report: parsed.data, blocking: blockingCount(parsed.data.findings), usd };
}

function reviewPrompt(input: ReviewInput, unplanned: readonly string[]): string {
  const lines = [`# Review ${input.ticketKey}`, ''];

  if (input.claim) {
    lines.push(
      '## What this pull request claims to do',
      `**${input.claim.title}**`,
      '',
      input.claim.body.trim() || '_The description is empty._',
      '',
    );
  } else {
    lines.push('## What was asked for', input.spec?.problem ?? '(no specification was recorded)');
  }

  if (input.spec?.acceptanceCriteria.length) {
    lines.push('', '### Acceptance criteria',
      ...input.spec.acceptanceCriteria.map((ac) => `- **${ac.id}** ${ac.statement}`));
  }
  if (input.spec?.outOfScope.length) {
    lines.push('', '### Explicitly out of scope',
      ...input.spec.outOfScope.map((o) => `- ${o}`));
  }
  if (input.plan) {
    lines.push('', '## The approved plan', input.plan.strategy, '',
      ...input.plan.tasks.map((t) => `- **${t.id}** ${t.title} — files: ${t.files.join(', ') || '(none predicted)'}`));
  }

  lines.push('', '## Gate results');
  for (const g of input.gateReports) {
    lines.push(`- \`${g.gate}\`: ${g.ok ? 'passed' : 'FAILED'}${g.failures.length ? ` (${g.failures.length} failure(s))` : ''}`);
  }

  if (unplanned.length > 0) {
    // Handed over as fact. The model judges whether it is justified; it is not
    // asked to work out which files were unplanned.
    lines.push('', '## Files changed that no task predicted',
      ...unplanned.map((f) => `- \`${f}\``),
      '',
      'Decide whether each is a reasonable consequence of the work or scope creep.');
  }

  lines.push('', '## The diff');
  if (input.diffTruncated) {
    lines.push('_Truncated — review what is here and say in your summary that you did not see all of it._');
  }
  lines.push('```diff', input.diff, '```');
  lines.push('', BRIEF);
  if (input.claim) lines.push('', CLAIM_CONFORMANCE);
  if (input.adversarial) lines.push('', ADVERSARIAL);
  return lines.join('\n');
}
