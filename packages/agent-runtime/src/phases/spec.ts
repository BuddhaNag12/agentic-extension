import { z } from 'zod';
import type { ResolvedWorkflow } from '@agentflow/protocol';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { GuardrailContext } from '../guardrails/types.js';
import { composePrompt, untrusted } from '../prompts/compose.js';
import type { ContextDigest } from './harvest.js';

/**
 * Stage 2 — Spec (§5). Read-only. Turns a ticket plus the harvest digest into
 * a specification whose every requirement points at something real.
 */

/**
 * Where a claim came from. The `quote` is verbatim and is checked against the
 * source text: requiring provenance is the cheapest available defence against
 * hallucinated scope, because the model cannot fill the field without pointing
 * at something that exists.
 */
export const Provenance = z.object({
  kind: z.enum(['ticket', 'context', 'design']),
  ref: z.string().min(1),
  quote: z.string().min(8).max(300),
});
export type Provenance = z.infer<typeof Provenance>;

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC\d+$/),
  statement: z.string().min(10),
  source: Provenance,
  /** Whether a machine can decide this. Unverifiable ACs become risks, not gates. */
  checkable: z.boolean(),
});

export const Assumption = z.object({
  id: z.string().regex(/^A\d+$/),
  statement: z.string().min(10),
  confidence: z.number().min(0).max(1),
  impactIfWrong: z.enum(['low', 'medium', 'high']),
  /** Required for high impact — see SPEC_VALID rule S4. */
  questionId: z.string().optional(),
});

export const OpenQuestion = z.object({
  id: z.string().regex(/^Q\d+$/),
  question: z.string().min(10).max(280),
  whyItMatters: z.string().min(10).max(200),
  alreadyChecked: z.array(z.string()).min(1),
  blocking: z.boolean(),
  options: z.array(z.object({ label: z.string(), implication: z.string() })).max(4).optional(),
});

export const Spec = z.object({
  problem: z.string().min(20),
  inScope: z.array(z.string()).min(1),
  outOfScope: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  affectedSurfaces: z.object({
    modules: z.array(z.string()),
    apis: z.array(z.string()),
    screens: z.array(z.string()),
    flags: z.array(z.string()),
  }),
  assumptions: z.array(Assumption),
  openQuestions: z.array(OpenQuestion),
  nonFunctional: z.object({
    perf: z.string(),
    security: z.string(),
    accessibility: z.string(),
    telemetry: z.string(),
  }),
  rollback: z.string().min(10),
});
export type Spec = z.infer<typeof Spec>;

export interface SpecViolation {
  rule: 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  message: string;
  path?: string;
}

/**
 * The SPEC_VALID gate (§5 Stage 2). Deterministic — no model in the decision
 * path. Every failure names the rule and the offending element so the analyst
 * can be handed something specific rather than "try again".
 */
export function validateSpec(
  spec: Spec,
  sources: { ticket: string; digest?: ContextDigest },
): SpecViolation[] {
  const issues: SpecViolation[] = [];
  const ticket = normalize(sources.ticket);
  const contextText = normalize(JSON.stringify(sources.digest ?? {}));

  for (const ac of spec.acceptanceCriteria) {
    const quote = normalize(ac.source.quote);

    // S1 — a quote attributed to the ticket must actually appear in the ticket.
    // This is the rule that stops invented requirements: the model can write any
    // statement it likes, but it cannot manufacture the evidence for it.
    if (ac.source.kind === 'ticket' && !ticket.includes(quote)) {
      issues.push({
        rule: 'S1', path: ac.id,
        message: `${ac.id} cites the ticket but its quote does not appear there: "${ac.source.quote.slice(0, 60)}"`,
      });
    }

    // S2 — same for the harvest digest.
    if (ac.source.kind === 'context' && sources.digest && !contextText.includes(quote)) {
      issues.push({
        rule: 'S2', path: ac.id,
        message: `${ac.id} cites the harvest context but its quote does not appear there: "${ac.source.quote.slice(0, 60)}"`,
      });
    }
  }

  // S3 — at least one AC must be machine-checkable, or nothing downstream can
  // ever prove the work is done.
  if (!spec.acceptanceCriteria.some((ac) => ac.checkable)) {
    issues.push({
      rule: 'S3', path: 'acceptanceCriteria',
      message: 'no acceptance criterion is machine-checkable; the plan would have nothing to verify against',
    });
  }

  // S4 — a high-impact assumption without a question is a decision taken
  // silently on the human's behalf.
  const questionIds = new Set(spec.openQuestions.map((q) => q.id));
  for (const a of spec.assumptions) {
    if (a.impactIfWrong !== 'high') continue;
    if (!a.questionId) {
      issues.push({
        rule: 'S4', path: a.id,
        message: `${a.id} is high-impact but asks nothing; a high-impact assumption needs a corresponding open question`,
      });
    } else if (!questionIds.has(a.questionId)) {
      issues.push({
        rule: 'S4', path: a.id,
        message: `${a.id} references question ${a.questionId}, which is not in openQuestions`,
      });
    }
  }

  // S5 — scope must not contradict itself.
  const inScope = new Set(spec.inScope.map(normalize));
  for (const out of spec.outOfScope) {
    if (inScope.has(normalize(out))) {
      issues.push({ rule: 'S5', path: 'outOfScope', message: `"${out}" is listed as both in and out of scope` });
    }
  }

  return issues;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface SpecInput {
  ticketKey: string;
  ticketDescription: string;
  digest: ContextDigest;
  worktree: string;
  workflow: ResolvedWorkflow;
  repoProfile?: string;
  /** Answers from a previous clarify pass, folded into a re-spec (§5 Stage 3). */
  answers?: { question: string; answer: string }[];
}

export interface SpecResult {
  ok: boolean;
  spec?: Spec;
  violations: SpecViolation[];
  error?: string;
  turns: AgentTurn[];
  usd: number;
}

const PHASE_BRIEF = `
Write the specification for this ticket. You are not writing code, and you have
no write access.

Every acceptance criterion must carry a **source** with a verbatim quote from the
ticket or the harvest context. That quote is checked against the original text —
a criterion you cannot source is a requirement you invented, and the gate will
reject it. If the ticket does not say something, do not put it in the spec:
either leave it out, or record it as an assumption with an open question.

Mark an acceptance criterion \`checkable: true\` only when a command could decide
it. "The page loads quickly" is not checkable; "the endpoint returns 200 within
200ms under the existing load test" is.

Every assumption whose \`impactIfWrong\` is "high" must reference an open question
by id. Deciding a high-impact question silently on the human's behalf is the
failure this rule exists to prevent.

Return JSON matching the schema you were given. Nothing else.
`.trim();

export async function runSpec(
  provider: AgentProvider,
  input: SpecInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<SpecResult> {
  const guardrails: GuardrailContext = {
    worktree: input.worktree,
    allowedPaths: ['<<none>>'],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    filesTouched: new Set(),
    allowDependencyChanges: false,
    failingTestFiles: [],
  };

  const binding = input.workflow.agents.analyst
    ?? { model: 'opus' as const, effort: 'high' as const, thinking: 'adaptive' as const };

  const prompt = composePrompt({
    role: 'analyst',
    workflow: input.workflow,
    ...(input.repoProfile ? { repoProfile: input.repoProfile } : {}),
    phaseBrief: PHASE_BRIEF,
    gates: ['SPEC_VALID'],
    allowedPaths: [],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    questionsRemaining: input.workflow.hitl.maxQuestionsPerPhase,
  });

  const opts: SessionOptions = {
    role: 'analyst',
    model: binding.model,
    effort: binding.effort,
    thinking: binding.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: binding.maxTurns ?? 20,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 4,
    outputSchema: z.toJSONSchema(Spec),
    guardrails,
  };

  const session = await provider.createSession(opts);
  const turns: AgentTurn[] = [];
  let usd = 0;
  let raw: unknown;
  let error: string | undefined;

  try {
    const task = [
      `Ticket ${input.ticketKey}.`,
      '',
      untrusted(`ticket:${input.ticketKey}`, input.ticketDescription),
      '',
      '# Harvest context (produced by a read-only exploration of this repository)',
      '',
      '```json',
      JSON.stringify(input.digest, null, 2),
      '```',
      ...(input.answers?.length
        ? ['', '# Answers from the human', '', ...input.answers.map((a) => `- **${a.question}** → ${a.answer}`)]
        : []),
      '',
      PHASE_BRIEF,
    ].join('\n');

    for await (const turn of session.send(task)) {
      turns.push(turn);
      onTurn?.(turn);
      if (turn.type === 'usage') usd += turn.usage?.usd ?? 0;
      if (turn.type === 'done') raw = turn.result;
      if (turn.type === 'error') error = turn.error;
    }
  } finally {
    await session.close();
  }

  if (error) return { ok: false, violations: [], error, turns, usd };

  const parsed = Spec.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, violations: [], turns, usd,
      error: `spec did not match the schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const violations = validateSpec(parsed.data, {
    ticket: input.ticketDescription,
    digest: input.digest,
  });
  return { ok: violations.length === 0, spec: parsed.data, violations, turns, usd };
}
