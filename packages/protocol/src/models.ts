import { z } from 'zod';

/**
 * The model catalogue (§21.4). Workflow files name an alias; this is the only
 * place a raw model ID appears, so a model rename is a one-file change.
 *
 * Prices are USD per million tokens and exist to drive the estimate shown at
 * Gate 2 and the usage view. Treat them as an estimate and reconcile against
 * the Console periodically (§15).
 */

export const ModelAlias = z.enum(['fable', 'opus', 'sonnet', 'haiku']);
export type ModelAlias = z.infer<typeof ModelAlias>;

export interface ModelSpec {
  alias: ModelAlias;
  id: string;
  displayName: string;
  contextWindow: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Not available under zero-data-retention; a policy question in a regulated repo. */
  requiresDataRetention: boolean;
}

export const MODEL_CATALOGUE: Record<ModelAlias, ModelSpec> = {
  fable: {
    alias: 'fable', id: 'claude-fable-5', displayName: 'Claude Fable 5',
    contextWindow: 1_000_000, inputUsdPerMTok: 10, outputUsdPerMTok: 50,
    requiresDataRetention: true,
  },
  opus: {
    alias: 'opus', id: 'claude-opus-5', displayName: 'Claude Opus 5',
    contextWindow: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25,
    requiresDataRetention: false,
  },
  sonnet: {
    alias: 'sonnet', id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5',
    contextWindow: 1_000_000, inputUsdPerMTok: 2, outputUsdPerMTok: 10,
    requiresDataRetention: false,
  },
  haiku: {
    alias: 'haiku', id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000, inputUsdPerMTok: 1, outputUsdPerMTok: 5,
    requiresDataRetention: false,
  },
};

/** Depth and token spend. `high` is the default; `xhigh` suits agentic work. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

/** Adaptive is the only on-mode on current models; fixed token budgets are gone. */
export const ThinkingMode = z.enum(['adaptive', 'off']);
export type ThinkingMode = z.infer<typeof ThinkingMode>;

/**
 * Roles that can be bound to a model (§6.1). `verifier` is deliberately absent:
 * verification is deterministic, and letting a workflow put a model in that
 * seat would reintroduce the failure mode the whole design prevents (§21.3).
 */
export const AgentRole = z.enum([
  'triage', 'harvest', 'analyst', 'planner',
  'implementer', 'repair', 'reviewer', 'summarizer',
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Named so the W4 rejection message can be specific rather than "unknown key". */
export const FORBIDDEN_ROLES = ['verifier'] as const;

export function estimateUsd(alias: ModelAlias, inputTokens: number, outputTokens: number): number {
  const spec = MODEL_CATALOGUE[alias];
  return (inputTokens / 1e6) * spec.inputUsdPerMTok + (outputTokens / 1e6) * spec.outputUsdPerMTok;
}
