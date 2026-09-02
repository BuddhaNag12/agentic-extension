/**
 * Tool-level permissions (§7.4). Three layers, all enforced in code:
 * a deterministic policy hook, a callback for what falls through to a prompt,
 * and hard blocks no mode bypasses.
 *
 * The point of enforcing here rather than in a prompt is §14's threat model:
 * the model is credulous and its inputs are attacker-influenced. Prompt
 * injection cannot escalate privilege if privilege is not the model's to grant.
 */

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export type GuardrailDecision =
  /** Proceed without asking. */
  | { decision: 'allow' }
  /**
   * Refuse. The reason is fed back to the agent as a tool result, which
   * usually redirects it productively — so it is written for the agent to act
   * on, not as an error string for a log.
   */
  | { decision: 'deny'; rule: string; reason: string }
  /** Escalate to the human as a non-modal permission chip (§7.4 Layer 2). */
  | { decision: 'ask'; rule: string; reason: string };

export interface GuardrailContext {
  /** Absolute path; every write must resolve inside it. */
  worktree: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  maxFilesTouched: number;
  /** Repo-relative paths written so far this task. */
  filesTouched: ReadonlySet<string>;
  allowDependencyChanges: boolean;
  /**
   * Test files in the currently failing set. Editing one requires human
   * approval: a repair loop that deletes the failing test reports success
   * while making things strictly worse (§9.3).
   */
  failingTestFiles: readonly string[];
  /** Bash commands permitted without a prompt. */
  allowedBashPrefixes?: readonly string[];
}

export const ALLOW: GuardrailDecision = { decision: 'allow' };

export const deny = (rule: string, reason: string): GuardrailDecision =>
  ({ decision: 'deny', rule, reason });

export const ask = (rule: string, reason: string): GuardrailDecision =>
  ({ decision: 'ask', rule, reason });
