import type { AgentRole, Effort, ModelAlias, ThinkingMode } from '@agentflow/protocol';
import type { GuardrailContext, GuardrailDecision, ToolCall } from '../guardrails/types.js';

/**
 * The provider seam (§17.3). One implementation ships (Claude). The interface
 * exists so provider-specific behaviour lives in one file — but be honest that
 * the design leans on Agent SDK capabilities (hooks, subagents, checkpointing,
 * structured output) that other runtimes do not all have. Porting would mean
 * reimplementing them, not swapping a client.
 */

export interface SessionOptions {
  role: AgentRole;
  model: ModelAlias;
  effort: Effort;
  thinking: ThinkingMode;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Resume a prior session; with `fork`, share history but diverge (§6.2). */
  resume?: string;
  fork?: boolean;
  /** JSON Schema the result must satisfy — the orchestrator parses, not reads. */
  outputSchema?: unknown;
  guardrails: GuardrailContext;
  /**
   * Overrides the provider's default hook for this session. The implement
   * phase uses it to record each allowed write, so the touch budget is
   * evaluated against what has actually happened rather than a snapshot.
   */
  permissionHook?: PermissionHook;
}

export interface AgentTurn {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'usage' | 'done' | 'error';
  text?: string;
  tool?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  usage?: { inputTokens: number; outputTokens: number; usd: number };
  /** Present on `done`, validated against `outputSchema` when one was given. */
  result?: unknown;
  error?: string;
}

export interface AgentSession {
  readonly id: string;
  /** Stream the turns produced by one prompt. */
  send(prompt: string): AsyncIterable<AgentTurn>;
  interrupt(): Promise<void>;
  /** Files restored to a prior message; always preview with dryRun first (§7.5). */
  rewindFiles(messageUuid: string, dryRun: boolean): Promise<{ files: string[] }>;
  contextUsage(): Promise<{ used: number; window: number }>;
  close(): Promise<void>;
}

export interface ProviderCapabilities {
  hooks: boolean;
  subagents: boolean;
  structuredOutput: boolean;
  checkpointing: boolean;
  permissions: boolean;
}

export interface AgentProvider {
  readonly id: string;
  createSession(opts: SessionOptions): Promise<AgentSession>;
  capabilities(): ProviderCapabilities;
  /** Model ids the account can actually use; validated at startup (§21.4). */
  supportedModels(): Promise<string[]>;
}

/** Called before every tool call; the provider must honour the decision. */
export type PermissionHook = (call: ToolCall, ctx: GuardrailContext) => GuardrailDecision;
