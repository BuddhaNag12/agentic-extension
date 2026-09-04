import { z } from 'zod';
import type { ResolvedWorkflow } from '@agentflow/protocol';
import { checkToolCall, WRITE_TOOL_NAMES } from '../guardrails/index.js';
import { toWorktreeRelative } from '../guardrails/paths.js';
import type { GuardrailContext, GuardrailDecision, ToolCall } from '../guardrails/types.js';
import { composePrompt } from '../prompts/compose.js';
import type { AgentProvider, AgentTurn, SessionOptions } from '../providers/types.js';
import type { WorkPacket } from './decompose.js';

/**
 * Stage 6 — Implement (§5). The first phase that writes.
 *
 * The guardrails do the work here: the packet's allowlist, the touch budget and
 * the §9.3 anti-patterns are all enforced by the hook, so scope discipline does
 * not depend on the model having read its instructions.
 */

/** What the implementer must report. Its beliefs are evidence, never verdict. */
export const ImplementReport = z.object({
  summary: z.string().min(20),
  changed: z.array(z.object({
    path: z.string(),
    what: z.string().min(5),
  })).min(1),
  /** ACs it *believes* it satisfied. The gates decide (§1.4). */
  believesSatisfied: z.array(z.string()),
  /** Deliberate omissions, so review can tell them from oversights. */
  deliberatelyNotDone: z.array(z.string()),
  followUps: z.array(z.string()),
});
export type ImplementReport = z.infer<typeof ImplementReport>;

export interface ImplementInput {
  packet: WorkPacket;
  worktree: string;
  workflow: ResolvedWorkflow;
  repoProfile?: string;
  /** Test files currently failing; editing one is refused (§9.3). */
  failingTestFiles?: readonly string[];
}

export interface DeniedCall {
  tool: string;
  path?: string;
  /** The bash command, when the refusal was of one — otherwise it cannot be audited. */
  command?: string;
  rule: string;
  reason: string;
}

export interface ImplementResult {
  ok: boolean;
  report?: ImplementReport;
  /** Worktree-relative paths the hook actually permitted. */
  filesTouched: string[];
  denied: DeniedCall[];
  error?: string;
  turns: AgentTurn[];
  usd: number;
}

const PHASE_BRIEF = `
Implement exactly this task. Read the files in your context slice before editing
anything.

You are judged by the gates listed above, not by your own assessment. When you
are done, report what you changed, which acceptance criteria you believe are now
satisfied, and anything you deliberately did not do — the reviewer needs to tell
a deliberate omission from an oversight.

Stay inside the task. If the change genuinely needs a file outside your allowed
paths, stop and say so rather than widening scope: the write will be refused and
you will have spent a turn.

Return JSON matching the schema you were given. Nothing else.
`.trim();

export async function runImplement(
  provider: AgentProvider,
  input: ImplementInput,
  onTurn?: (turn: AgentTurn) => void,
): Promise<ImplementResult> {
  const { packet } = input;
  // Live, not a snapshot: the touch budget must count what has actually been
  // written so far in this session, so the Nth write is judged against N-1.
  const filesTouched = new Set<string>();
  const denied: DeniedCall[] = [];

  const guardrails: GuardrailContext = {
    worktree: input.worktree,
    allowedPaths: packet.guardrails.allowedPaths,
    forbiddenPaths: packet.guardrails.forbiddenPaths,
    maxFilesTouched: packet.guardrails.maxFilesTouched,
    filesTouched,
    allowDependencyChanges: packet.guardrails.maxNewDeps > 0,
    failingTestFiles: input.failingTestFiles ?? [],
  };

  /** Records what was permitted, and what was not and why. */
  const hook = (call: ToolCall, ctx: GuardrailContext): GuardrailDecision => {
    const decision = checkToolCall(call, ctx);
    const raw = call.input['file_path'] ?? call.input['path'];
    const rel = typeof raw === 'string' ? toWorktreeRelative(ctx.worktree, raw).path : undefined;

    if (decision.decision === 'allow') {
      // Only a write touches a file. Counting reads here would spend the
      // budget on exploration the task is supposed to do.
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

  const binding = input.workflow.agents.implementer
    ?? { model: 'sonnet' as const, effort: 'medium' as const, thinking: 'adaptive' as const };

  const prompt = composePrompt({
    role: 'implementer',
    workflow: input.workflow,
    ...(input.repoProfile ? { repoProfile: input.repoProfile } : {}),
    phaseBrief: PHASE_BRIEF,
    gates: packet.gates,
    allowedPaths: packet.guardrails.allowedPaths,
    forbiddenPaths: input.workflow.guardrails.forbiddenPaths,
    maxFilesTouched: packet.guardrails.maxFilesTouched,
    questionsRemaining: 0,
  });

  const opts: SessionOptions = {
    role: 'implementer',
    model: binding.model,
    effort: binding.effort,
    thinking: binding.thinking,
    systemPrompt: prompt.system,
    cwd: input.worktree,
    maxTurns: binding.maxTurns ?? 60,
    maxBudgetUsd: input.workflow.budgets.perRunUsd / 2,
    outputSchema: z.toJSONSchema(ImplementReport),
    guardrails,
    permissionHook: hook,
  };

  const session = await provider.createSession(opts);
  const turns: AgentTurn[] = [];
  let usd = 0;
  let raw: unknown;
  let error: string | undefined;

  try {
    for await (const turn of session.send(taskPrompt(packet))) {
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
  if (error) return { ok: false, filesTouched: touched, denied, error, turns, usd };

  const parsed = ImplementReport.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false, filesTouched: touched, denied, turns, usd,
      error: `report did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  // A task that reports success having written nothing has not done the work.
  // The gates decide correctness; this only catches the empty case.
  if (touched.length === 0) {
    return { ok: false, report: parsed.data, filesTouched: touched, denied, turns, usd, error: 'no files were written' };
  }
  return { ok: true, report: parsed.data, filesTouched: touched, denied, turns, usd };
}

function taskPrompt(packet: WorkPacket): string {
  const { task, contextSlice } = packet;
  return [
    `# Task ${task.id} — ${task.title}`,
    '',
    task.intent,
    '',
    '## Read these first',
    ...contextSlice.files.map((f) => `- \`${f}\``),
    '',
    '## Acceptance criteria this task serves',
    ...contextSlice.specExcerpt.map((ac) => `- **${ac.id}** ${ac.statement}${ac.checkable ? '' : ' _(not machine-checkable)_'}`),
    '',
    '## How this task will be judged',
    ...task.checks.map((c) => `- [${c.gate}] ${c.how}`),
    ...(contextSlice.conventions.length
      ? ['', '## Conventions in this repository', ...contextSlice.conventions.map((c) => `- ${c}`)]
      : []),
    ...(contextSlice.completed.length
      ? ['', '## Already done by earlier tasks — do not redo', ...contextSlice.completed.map((t) => `- ${t.id}: ${t.title}`)]
      : []),
    '',
    PHASE_BRIEF,
  ].join('\n');
}
