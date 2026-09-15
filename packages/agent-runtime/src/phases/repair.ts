import { z } from 'zod';
import type { Failure, GateId, ResolvedWorkflow } from '@agentflow/protocol';
import { checkToolCall, WRITE_TOOL_NAMES } from '../guardrails/index.js';
import { toWorktreeRelative } from '../guardrails/paths.js';
import type { GuardrailContext, GuardrailDecision, ToolCall } from '../guardrails/types.js';
import { composePrompt } from '../prompts/compose.js';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { WorkPacket } from './decompose.js';
import type { DeniedCall } from './implement.js';

/**
 * The repair step of Build (§11) — the correctness engine's inner loop.
 *
 * Each attempt is given strictly more than the last, and the ladder (§11.2) is
 * about *context and model*, not about trying harder: an identical retry is the
 * definition of thrash. Rungs 4 and 5 — rewind-and-replan, and escalate to a
 * human — are transitions the state machine owns, because they leave the step.
 */

export type RepairRung = 'local' | 'widen' | 'rethink';

/** §11.2, attempts 1–3. Beyond that the machine takes over. */
export function rungFor(attempt: number): RepairRung {
  if (attempt <= 1) return 'local';
  if (attempt === 2) return 'widen';
  return 'rethink';
}

export const RepairReport = z.object({
  /** Why it failed. Stated before the fix, so a wrong theory is visible. */
  diagnosis: z.string().min(20),
  fix: z.string().min(10),
  changed: z.array(z.object({ path: z.string(), what: z.string().min(5) })).min(1),
  /** One line, for the next rung's "these approaches failed" list. */
  approach: z.string().min(10).max(160),
  /** Its own estimate. Evidence for the loop's decisions, never a verdict. */
  confidence: z.number().min(0).max(1),
});
export type RepairReport = z.infer<typeof RepairReport>;

export interface RepairInput {
  packet: WorkPacket;
  worktree: string;
  workflow: ResolvedWorkflow;
  /** The gate that went red, and what it reported (top 20 already applied). */
  gate: GateId;
  failures: readonly Failure[];
  /** 1-based. Selects the rung. */
  attempt: number;
  /**
   * One line per previous attempt. Rung 3 gets these *instead* of the failed
   * sessions' reasoning: inheriting the reasoning inherits the blind spot that
   * produced it (§11.2).
   */
  priorApproaches?: readonly string[];
  /** What the implementer just wrote — the diff rung 1 reasons about. */
  recentlyTouched?: readonly string[];
  repoProfile?: string;
}

export interface RepairResult {
  ok: boolean;
  rung: RepairRung;
  report?: RepairReport;
  filesTouched: string[];
  denied: DeniedCall[];
  error?: string;
  turns: AgentTurn[];
  usd: number;
}

/**
 * Test files named in the failures.
 *
 * This is what makes §11.3's first anti-pattern enforceable: the guardrail
 * refuses edits that remove assertions from a *failing* test, and it cannot
 * know which those are unless something tells it. The field existed on every
 * phase input and nothing ever populated it, so the rule was inert exactly
 * where it matters most — a red gate is when deleting the test is tempting.
 */
export function failingTestFilesFrom(failures: readonly Failure[]): string[] {
  const isTest = /(^|\/)(__tests__|test|tests|spec)\//i;
  const named = /\.(test|spec)\.[cm]?[jt]sx?$/i;
  const out = new Set<string>();
  for (const f of failures) {
    if (f.file && (named.test(f.file) || isTest.test(f.file))) out.add(f.file);
  }
  return [...out];
}

const BRIEF = `
A gate is red. Fix the cause.

Diagnose before you edit: say what actually broke and why, then fix that. A
change you cannot explain is a guess, and a guess that happens to go green is
worse than a failure — it hides the defect.

You may not make the gate pass by weakening what it checks. Deleting a failing
test, skipping it, loosening an assertion, or swallowing the error in a catch
will be refused by the tool layer and will cost you the attempt.

Return JSON matching the schema you were given. Nothing else.
`.trim();

const RUNG_BRIEF: Record<RepairRung, string> = {
  local: 'This is the first attempt. The cause is most likely in the diff you just wrote.',
  widen:
    'The obvious fix did not work. Read the failing test in full, the code it ' +
    'exercises, and the recent history of that area before editing — the cause ' +
    'is probably outside the lines you changed.',
  rethink:
    'Two attempts have failed. Do not repeat them. Re-read the task from the ' +
    'specification and consider that the original approach may be wrong rather ' +
    'than incomplete.',
};

export async function runRepair(
  provider: AgentProvider,
  input: RepairInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<RepairResult> {
  const { packet } = input;
  const rung = rungFor(input.attempt);
  const filesTouched = new Set<string>();
  const denied: DeniedCall[] = [];

  const guardrails: GuardrailContext = {
    worktree: input.worktree,
    allowedPaths: packet.guardrails.allowedPaths,
    forbiddenPaths: packet.guardrails.forbiddenPaths,
    maxFilesTouched: packet.guardrails.maxFilesTouched,
    filesTouched,
    allowDependencyChanges: packet.guardrails.maxNewDeps > 0,
    failingTestFiles: failingTestFilesFrom(input.failures),
  };

  const hook = (call: ToolCall, ctx: GuardrailContext): GuardrailDecision => {
    const decision = checkToolCall(call, ctx);
    const raw = call.input['file_path'] ?? call.input['path'];
    const rel = typeof raw === 'string' ? toWorktreeRelative(ctx.worktree, raw).path : undefined;

    if (decision.decision === 'allow') {
      if (rel && WRITE_TOOL_NAMES.has(call.tool)) filesTouched.add(rel);
    } else {
      const command = typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
      denied.push({
        tool: call.tool,
        ...(rel ? { path: rel } : {}),
        ...(command ? { command } : {}),
        rule: decision.rule,
        reason: decision.reason,
      });
    }
    return decision;
  };

  const bound = input.workflow.agents.repair
    ?? { model: 'sonnet' as const, effort: 'medium' as const, thinking: 'adaptive' as const };
  // §11.2 rung 3 switches model and starts clean. `escalateTo` is the
  // workflow's say in which model that is.
  const model = rung === 'rethink' ? (bound.escalateTo ?? bound.model) : bound.model;
  const effort = rung === 'rethink' ? ('high' as const) : bound.effort;

  const prompt = composePrompt({
    role: 'repair',
    workflow: input.workflow,
    ...(input.repoProfile ? { repoProfile: input.repoProfile } : {}),
    phaseBrief: `${BRIEF}\n\n${RUNG_BRIEF[rung]}`,
    gates: packet.gates,
    allowedPaths: packet.guardrails.allowedPaths,
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: packet.guardrails.maxFilesTouched,
    questionsRemaining: 0,
  });

  const opts: SessionOptions = {
    role: 'repair',
    model,
    effort,
    thinking: bound.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: bound.maxTurns ?? 40,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 3,
    outputSchema: z.toJSONSchema(RepairReport),
    guardrails,
    permissionHook: hook,
  };

  const session = await provider.createSession(opts);
  const turns: AgentTurn[] = [];
  let usd = 0;
  let raw: unknown;
  let error: string | undefined;

  try {
    for await (const turn of session.send(repairPrompt(input, rung))) {
      turns.push(turn);
      onTurn?.(turn);
      if (turn.type === 'usage') usd += turn.usage?.usd ?? 0;
      if (turn.type === 'done') raw = turn.result;
      if (turn.type === 'error') error = turn.error;
    }
  } finally {
    await session.close();
  }

  const touched = [...filesTouched];
  if (error) return { ok: false, rung, filesTouched: touched, denied, error, turns, usd };

  const parsed = RepairReport.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, rung, filesTouched: touched, denied, turns, usd,
      error: `repair report did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  // §11.3's last row: a fix claimed without an edit is not a fix. The gate rerun
  // decides whether it worked; this only catches the empty claim.
  if (touched.length === 0) {
    return {
      ok: false, rung, report: parsed.data, filesTouched: touched, denied, turns, usd,
      error: 'repair claimed a fix but wrote nothing',
    };
  }
  return { ok: true, rung, report: parsed.data, filesTouched: touched, denied, turns, usd };
}

function repairPrompt(input: RepairInput, rung: RepairRung): string {
  const { packet, failures, gate } = input;
  const lines = [
    `# Repair attempt ${input.attempt} — task ${packet.task.id}: ${packet.task.title}`,
    '',
    `The \`${gate}\` gate is red.`,
    '',
    '## What it reported',
    ...failures.map((f) => `- ${location(f)}${f.rule ? `[${f.rule}] ` : ''}${f.message}`),
    '',
    '## What this task was meant to do',
    packet.task.intent,
  ];

  if (rung === 'local' && input.recentlyTouched?.length) {
    lines.push('', '## Files just written — start here', ...input.recentlyTouched.map((f) => `- \`${f}\``));
  }
  if (rung !== 'local') {
    lines.push('', '## Read in full before editing', ...packet.contextSlice.files.map((f) => `- \`${f}\``));
  }
  if (input.priorApproaches?.length) {
    // Summaries only. The reasoning that produced them is deliberately absent.
    lines.push('', '## Approaches already tried, and failed', ...input.priorApproaches.map((a) => `- ${a}`));
  }

  lines.push('', '## How this task is judged', ...packet.task.checks.map((c) => `- [${c.gate}] ${c.how}`));
  lines.push('', BRIEF, '', RUNG_BRIEF[rung]);
  return lines.join('\n');
}

function location(f: Failure): string {
  if (!f.file) return '';
  return f.line === undefined ? `\`${f.file}\` ` : `\`${f.file}:${f.line}\` `;
}
