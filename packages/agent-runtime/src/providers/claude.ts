import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { MODEL_CATALOGUE } from '@agentflow/protocol';
import { checkToolCall } from '../guardrails/index.js';
import type {
  AgentProvider, AgentSession, AgentTurn, PermissionHook, ProviderCapabilities, SessionOptions,
} from './types.js';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk', { with: { 'resolution-mode': 'import' } });
let sdk: SdkModule | undefined;

/**
 * The Agent SDK is ESM-only and these packages are CommonJS, so a plain
 * `await import(...)` would be downlevelled to `require()` and fail at runtime.
 * Keeping the specifier opaque preserves a real dynamic import; the type import
 * above is erased and costs nothing.
 */
async function loadSdk(): Promise<SdkModule> {
  sdk ??= await (Function('return import("@anthropic-ai/claude-agent-sdk")')() as Promise<SdkModule>);
  return sdk;
}

/**
 * The Claude implementation of the provider seam (§17.3).
 *
 * The SDK drives the Claude Code CLI subprocess, which resolves its own
 * credentials — so a developer already signed into Claude Code needs no API key,
 * and runs bill to that account rather than to a separate API budget.
 *
 * Everything policy-related is enforced here through `canUseTool`, not through
 * the prompt: §14's threat model is a credulous model reading attacker-
 * influenced text, so injection must not be able to reach a tool the guardrails
 * would refuse.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';

  constructor(private readonly permissionHook: PermissionHook = checkToolCall) {}

  capabilities(): ProviderCapabilities {
    return { hooks: true, subagents: true, structuredOutput: true, checkpointing: true, permissions: true };
  }

  async supportedModels(): Promise<string[]> {
    return Object.values(MODEL_CATALOGUE).map((m) => m.id);
  }

  async createSession(opts: SessionOptions): Promise<AgentSession> {
    return new ClaudeSession(opts, this.permissionHook);
  }
}

class ClaudeSession implements AgentSession {
  readonly id = randomUUID();
  private active: Query | undefined;
  private sessionId: string | undefined;
  private lastUsage = { used: 0, window: 1_000_000 };

  constructor(
    private readonly opts: SessionOptions,
    private readonly permissionHook: PermissionHook,
  ) {}

  async *send(prompt: string): AsyncIterable<AgentTurn> {
    const { query } = await loadSdk();
    const q = query({ prompt, options: this.buildOptions() });
    this.active = q;

    try {
      for await (const message of q) {
        yield* this.translate(message);
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.active = undefined;
    }
  }

  private buildOptions(): Options {
    const spec = MODEL_CATALOGUE[this.opts.model];
    const options: Options = {
      model: spec.id,
      cwd: this.opts.cwd,
      systemPrompt: this.opts.systemPrompt,
      effort: this.opts.effort,
      // Never `bypassPermissions`: the extension does not expose it at all
      // (§7.4). Read-only roles get plan mode so no write is even attempted.
      permissionMode: this.opts.guardrails.allowedPaths.length === 0 && this.isReadOnlyRole()
        ? 'plan'
        : 'acceptEdits',
      canUseTool: this.canUseTool(),
      enableFileCheckpointing: true,
      includePartialMessages: false,
      // The run's own settings decide policy; inheriting the developer's local
      // Claude Code settings would make behaviour differ per machine.
      settingSources: [],
      disallowedTools: ['Bash(git push --force*)', 'Bash(git push -f*)'],
    };

    // Structured output is what makes the result parseable by the orchestrator
    // rather than read by it (§6.3). Without it the phase returns prose and the
    // schema check downstream fails on every run.
    if (this.opts.outputSchema) {
      options.outputFormat = { type: 'json_schema', schema: sanitizeSchema(this.opts.outputSchema) };
    }
    if (this.opts.maxTurns !== undefined) options.maxTurns = this.opts.maxTurns;
    if (this.opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = this.opts.maxBudgetUsd;
    const resume = this.opts.resume ?? this.sessionId;
    if (resume) options.resume = resume;
    if (this.opts.fork !== undefined) options.forkSession = this.opts.fork;
    return options;
  }

  private isReadOnlyRole(): boolean {
    return ['triage', 'harvest', 'analyst', 'planner', 'reviewer', 'summarizer'].includes(this.opts.role);
  }

  /** Every tool call passes the same guardrails the replay provider enforces. */
  private canUseTool(): CanUseTool {
    return async (toolName, input) => {
      const decision = this.permissionHook({ tool: toolName, input }, this.opts.guardrails);
      if (decision.decision === 'allow') return { behavior: 'allow', updatedInput: input };
      // Both `deny` and `ask` stop the call. `ask` reaching here means no human
      // is attached to answer it, and proceeding would be deciding on their
      // behalf — so it is refused with the reason, which the agent can act on.
      return { behavior: 'deny', message: `[${decision.rule}] ${decision.reason}` };
    };
  }

  private *translate(message: SDKMessage): Generator<AgentTurn> {
    const m = message as SDKMessage & Record<string, unknown>;

    if (typeof m['session_id'] === 'string') this.sessionId = m['session_id'];

    switch (m.type) {
      case 'assistant': {
        const content = (m['message'] as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] === 'text') {
            yield { type: 'text', text: String(block['text'] ?? '') };
          } else if (block['type'] === 'thinking') {
            yield { type: 'thinking', text: String(block['thinking'] ?? '') };
          } else if (block['type'] === 'tool_use') {
            yield {
              type: 'tool_call',
              tool: String(block['name'] ?? ''),
              toolUseId: String(block['id'] ?? ''),
              input: (block['input'] as Record<string, unknown>) ?? {},
            };
          }
        }
        break;
      }

      case 'user': {
        const content = (m['message'] as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] !== 'tool_result') continue;
          yield {
            type: 'tool_result',
            toolUseId: String(block['tool_use_id'] ?? ''),
            ok: block['is_error'] !== true,
            summary: summarize(block['content']),
          };
        }
        break;
      }

      case 'result': {
        const usage = m['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
        const usd = typeof m['total_cost_usd'] === 'number' ? m['total_cost_usd'] : 0;
        const inputTokens = usage?.input_tokens ?? 0;
        this.lastUsage = { used: inputTokens, window: MODEL_CATALOGUE[this.opts.model].contextWindow };
        yield { type: 'usage', usage: { inputTokens, outputTokens: usage?.output_tokens ?? 0, usd } };

        if (m['is_error'] === true || m['subtype'] !== 'success') {
          yield { type: 'error', error: String(m['result'] ?? m['subtype'] ?? 'run failed') };
          break;
        }
        yield { type: 'done', result: parseResult(m['result']) };
        break;
      }

      default:
        break;
    }
  }

  async interrupt(): Promise<void> {
    await this.active?.interrupt();
  }

  async rewindFiles(_messageUuid: string, _dryRun: boolean): Promise<{ files: string[] }> {
    // File checkpointing is enabled on the session; exposing rewind through the
    // seam waits until the repair loop actually drives it (M2).
    return { files: [] };
  }

  async contextUsage(): Promise<{ used: number; window: number }> {
    return this.lastUsage;
  }

  async close(): Promise<void> {
    await this.interrupt();
  }
}

/**
 * `z.toJSONSchema()` stamps a `$schema` pointing at draft 2020-12, which the
 * CLI's validator refuses to resolve ("no schema with key or ref ..."). The
 * key carries no information the model needs, so it is dropped.
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const { $schema: _drop, ...rest } = (schema ?? {}) as Record<string, unknown>;
  return rest;
}

/** Structured output arrives as JSON text; fall back to the raw string. */
function parseResult(result: unknown): unknown {
  if (typeof result !== 'string') return result;
  const start = result.indexOf('{');
  const end = result.lastIndexOf('}');
  if (start < 0 || end <= start) return result;
  try {
    return JSON.parse(result.slice(start, end + 1));
  } catch {
    return result;
  }
}

/** One line, never the whole payload — tool output belongs on disk (§5). */
function summarize(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c as { text?: string })?.text ?? '').join(' ')
      : JSON.stringify(content ?? '');
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
