import { z } from 'zod';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { GuardrailContext } from '../guardrails/types.js';
import { composePrompt, untrusted } from '../prompts/compose.js';
import type { ResolvedWorkflow } from '@agentflow/protocol';

/**
 * Stage 1 — Context Harvest (§5). The most under-invested stage in most
 * agentic tools, and the one that determines whether the plan is any good.
 *
 * Read-only by construction: the role gets no write paths, so the guardrail
 * hook refuses every edit regardless of what the model attempts.
 */

export const ContextDigest = z.object({
  modules: z.array(z.object({
    path: z.string(),
    purpose: z.string(),
  })).max(20),
  entryPoints: z.array(z.string()).max(10),
  /** Where this kind of change usually lands, with a reason. */
  likelyTouchSet: z.array(z.string()).max(20),
  conventions: z.array(z.string()).max(10),
  testLayout: z.object({
    framework: z.string(),
    location: z.string(),
    exampleTest: z.string().optional(),
  }),
  /** An existing implementation of the same concern, or an explicit admission. */
  precedent: z.union([
    z.object({ found: z.literal(true), path: z.string(), why: z.string() }),
    z.object({ found: z.literal(false), reason: z.literal('greenfield, no precedent') }),
  ]),
  risks: z.array(z.string()).max(10),
});
export type ContextDigest = z.infer<typeof ContextDigest>;

export interface HarvestInput {
  ticketKey: string;
  /** Untrusted: a ticket body is attacker-influenced text (§14). */
  ticketDescription: string;
  worktree: string;
  workflow: ResolvedWorkflow;
  repoProfile?: string;
}

export interface HarvestResult {
  ok: boolean;
  digest?: ContextDigest;
  error?: string;
  turns: AgentTurn[];
  usd: number;
}

const PHASE_BRIEF = `
Explore this repository and return a **bounded, structured digest** — never a raw dump.
The parent session will see only your digest, so it must stand alone.

Answer, from evidence in the repository:
1. Which modules exist and what each is for.
2. Where a change of this kind usually lands (the likely touch set), and why.
3. The conventions a change here must follow.
4. How tests are laid out, and what a good test here looks like.
5. Whether a similar feature already exists. If none does, say so explicitly
   rather than inventing a precedent — "greenfield, no precedent" is a valid,
   useful answer and a fabricated one poisons every phase after this.
6. Risks specific to this area (fragile code, past reverts, heavy coupling).

You have read-only access. Do not attempt to edit anything.
Return JSON matching the schema you were given. Nothing else.
`.trim();

export async function runHarvest(
  provider: AgentProvider,
  input: HarvestInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<HarvestResult> {
  const guardrails: GuardrailContext = {
    worktree: input.worktree,
    // No allowed paths at all: this phase reads, it does not write.
    allowedPaths: ['<<none>>'],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    filesTouched: new Set(),
    allowDependencyChanges: false,
    failingTestFiles: [],
  };

  const binding = input.workflow.agents.harvest ?? { model: 'sonnet' as const, effort: 'low' as const, thinking: 'adaptive' as const };

  const prompt = composePrompt({
    role: 'harvest',
    workflow: input.workflow,
    ...(input.repoProfile ? { repoProfile: input.repoProfile } : {}),
    phaseBrief: PHASE_BRIEF,
    gates: ['HARVEST_SUFFICIENT'],
    allowedPaths: [],
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: 0,
    questionsRemaining: 0,
  });

  const opts: SessionOptions = {
    role: 'harvest',
    model: binding.model,
    effort: binding.effort,
    thinking: binding.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: binding.maxTurns ?? 30,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 4,
    outputSchema: z.toJSONSchema(ContextDigest),
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

  if (error) return { ok: false, error, turns, usd };

  // HARVEST_SUFFICIENT (§5): schema-valid, and a non-empty touch set. A digest
  // that parses but predicts nothing is not a usable input to the spec.
  const parsed = ContextDigest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `digest did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`, turns, usd };
  }
  if (parsed.data.likelyTouchSet.length === 0) {
    return { ok: false, error: 'digest predicted an empty touch set', turns, usd };
  }
  return { ok: true, digest: parsed.data, turns, usd };
}
