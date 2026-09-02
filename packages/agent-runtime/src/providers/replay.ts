import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkToolCall } from '../guardrails/index.js';
import type {
  AgentProvider, AgentSession, AgentTurn, PermissionHook, ProviderCapabilities, SessionOptions,
} from './types.js';

/**
 * The replay model (§12.7) — the load-bearing piece of the test strategy.
 *
 * Record real sessions once, replay them in CI forever. Without it there is no
 * regression testing on orchestration logic, because live model calls are
 * nondeterministic, slow and expensive; with it, every state-machine change is
 * testable in seconds.
 *
 * Replay runs the **real guardrail hook** over the recorded tool calls, so a
 * transcript recorded before a policy tightened will correctly show the call
 * being denied now. A replay that skipped the hook would prove nothing about
 * the thing most worth proving.
 */

export interface RecordedSession {
  role: string;
  model: string;
  /** Keyed by prompt, or `*` for any prompt. */
  exchanges: { prompt: string; turns: AgentTurn[] }[];
}

export interface ReplayOptions {
  /** Denied tool calls become a `tool_result` the recorded agent must cope with. */
  permissionHook?: PermissionHook;
  /** Throw when a prompt has no recording, rather than returning nothing. */
  strict?: boolean;
}

export class ReplayProvider implements AgentProvider {
  readonly id = 'replay';

  constructor(
    private readonly sessions: Map<string, RecordedSession>,
    private readonly options: ReplayOptions = {},
  ) {}

  static fromFile(path: string, options: ReplayOptions = {}): ReplayProvider {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, RecordedSession>;
    return new ReplayProvider(new Map(Object.entries(raw)), options);
  }

  capabilities(): ProviderCapabilities {
    return { hooks: true, subagents: true, structuredOutput: true, checkpointing: true, permissions: true };
  }

  async supportedModels(): Promise<string[]> {
    return ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
  }

  async createSession(opts: SessionOptions): Promise<AgentSession> {
    const recorded = this.sessions.get(opts.role);
    if (!recorded && this.options.strict) {
      throw new Error(`no recorded session for role "${opts.role}"`);
    }
    return new ReplaySession(opts, recorded, this.options);
  }
}

class ReplaySession implements AgentSession {
  readonly id = randomUUID();
  private interrupted = false;
  private used = 0;

  constructor(
    private readonly opts: SessionOptions,
    private readonly recorded: RecordedSession | undefined,
    private readonly options: ReplayOptions,
  ) {}

  async *send(prompt: string): AsyncIterable<AgentTurn> {
    const exchange =
      this.recorded?.exchanges.find((e) => e.prompt === prompt)
      ?? this.recorded?.exchanges.find((e) => e.prompt === '*');

    if (!exchange) {
      if (this.options.strict) {
        throw new Error(`no recorded exchange for role "${this.opts.role}" and prompt: ${prompt.slice(0, 80)}`);
      }
      yield { type: 'error', error: 'no recording for this prompt', ok: false };
      return;
    }

    const hook = this.options.permissionHook ?? checkToolCall;

    for (const turn of exchange.turns) {
      if (this.interrupted) return;

      if (turn.type === 'tool_call') {
        const decision = hook({ tool: turn.tool ?? '', input: turn.input ?? {} }, this.opts.guardrails);
        yield turn;
        if (decision.decision !== 'allow') {
          // The recorded result is discarded: what the agent sees now is the
          // refusal, exactly as it would in a live run.
          yield {
            type: 'tool_result',
            toolUseId: turn.toolUseId ?? '',
            ok: false,
            summary: `${decision.decision === 'deny' ? 'denied' : 'needs approval'} (${decision.rule}): ${decision.reason}`,
          };
          continue;
        }
      }

      if (turn.type === 'tool_result' && this.wasBlocked(exchange.turns, turn)) continue;
      if (turn.type === 'usage') this.used += turn.usage?.inputTokens ?? 0;
      yield turn;
    }
  }

  /** Skip a recorded result whose call the hook refused a moment ago. */
  private wasBlocked(turns: readonly AgentTurn[], result: AgentTurn): boolean {
    const call = turns.find((t) => t.type === 'tool_call' && t.toolUseId === result.toolUseId);
    if (!call) return false;
    const hook = this.options.permissionHook ?? checkToolCall;
    return hook({ tool: call.tool ?? '', input: call.input ?? {} }, this.opts.guardrails).decision !== 'allow';
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async rewindFiles(_messageUuid: string, _dryRun: boolean): Promise<{ files: string[] }> {
    return { files: [] };
  }

  async contextUsage(): Promise<{ used: number; window: number }> {
    return { used: this.used, window: 1_000_000 };
  }

  async close(): Promise<void> {
    this.interrupted = true;
  }
}
