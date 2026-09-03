import { checkEdit, checkTouchBudget } from './antipatterns.js';
import { checkBash, DEFAULT_SAFE_PREFIXES } from './bash.js';
import { checkWritePath } from './paths.js';
import { findSecrets } from './secrets.js';
import { ALLOW, deny, type GuardrailContext, type GuardrailDecision, type ToolCall } from './types.js';

export * from './antipatterns.js';
export * from './bash.js';
export * from './paths.js';
export * from './secrets.js';
export * from './types.js';

/** Beyond this, an "edit" is a generated blob or a mistake. */
export const MAX_WRITE_BYTES = 512 * 1024;

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite', 'Task']);

/**
 * Runtime-internal tools that carry no file or shell side effect. The SDK
 * returns a phase's structured result through `StructuredOutput`; denying it
 * costs the model a retry per attempt and the phase its result.
 */
const RUNTIME_TOOLS = new Set(['StructuredOutput', 'ExitPlanMode', 'AskUserQuestion']);

/** Tools that write. Only these count against the touch budget. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_based_edit_tool',
]);

/**
 * The `PreToolUse` hook (§7.4 Layer 1). Deterministic policy applied before
 * every tool call, returning a decision the model can act on.
 *
 * Order matters: the checks that cannot be argued with run first, so a call
 * that is both out of scope and writing a secret is refused for the secret.
 */
export function checkToolCall(call: ToolCall, ctx: GuardrailContext): GuardrailDecision {
  if (READ_TOOLS.has(call.tool) || RUNTIME_TOOLS.has(call.tool)) return ALLOW;

  if (call.tool === 'Bash') {
    const command = String(call.input['command'] ?? '');
    return checkBash(command, ctx.allowedBashPrefixes ?? DEFAULT_SAFE_PREFIXES);
  }

  if (!WRITE_TOOL_NAMES.has(call.tool)) {
    return { decision: 'ask', rule: 'tool.unrecognized', reason: `"${call.tool}" is not on the auto-approved tool list.` };
  }

  const rawPath = String(call.input['file_path'] ?? call.input['path'] ?? '');
  if (!rawPath) return deny('tool.missing_path', `${call.tool} requires a file path.`);

  const pathVerdict = checkWritePath(
    {
      worktree: ctx.worktree,
      allowedPaths: ctx.allowedPaths,
      forbiddenPaths: ctx.forbiddenPaths,
      allowDependencyChanges: ctx.allowDependencyChanges,
    },
    rawPath,
  );
  if (!pathVerdict.ok) return deny(pathVerdict.rule!, pathVerdict.reason!);
  const path = pathVerdict.path!;

  const after = String(call.input['content'] ?? call.input['new_string'] ?? '');
  const before = String(call.input['old_string'] ?? '');

  if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
    return deny('tool.oversized_write',
      `this write is over ${Math.round(MAX_WRITE_BYTES / 1024)} KB. Generated or vendored content does not belong in a task edit.`);
  }

  const secrets = findSecrets(after);
  if (secrets.length > 0) {
    return deny('secret.in_write',
      `this write contains what looks like ${secrets[0]!.description}. Credentials belong in the environment, never in the repo.`);
  }

  const budget = checkTouchBudget(ctx.filesTouched, path, ctx.maxFilesTouched);
  if (budget.decision !== 'allow') return budget;

  return checkEdit({ path, before, after }, ctx.failingTestFiles);
}

/**
 * Was this call permitted? Both `deny` and `ask` stop the call; `ask` is the
 * one a human can turn into `allow` (§7.4 Layer 2).
 */
export function isAllowed(decision: GuardrailDecision): boolean {
  return decision.decision === 'allow';
}
