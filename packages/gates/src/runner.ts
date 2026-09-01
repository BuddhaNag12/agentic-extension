import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { failureSignature } from '@agentflow/core';
import type { Failure, GateId, GateReport } from '@agentflow/protocol';
import { topFailures, type GateAdapter, type RepoContext, type Scope } from './adapter.js';

/**
 * The gate runner (§5 Stage 7). Deterministic: no model sits in this decision
 * path. A gate passes because a command exited zero, and for no other reason.
 */

export interface RunGateOptions {
  repo: RepoContext;
  scope: Scope;
  /** Where full logs are written. Only the path enters the event log (§5). */
  logDir: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60_000;

export async function runGate(adapter: GateAdapter, opts: RunGateOptions): Promise<GateReport> {
  const started = Date.now();
  const { cmd, args, cwd, env } = adapter.command(opts.scope, opts.repo);

  const result = await spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env, ...opts.env, CI: '1' },
    timeoutMs: opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const durationMs = Date.now() - started;
  const raw = writeLog(opts.logDir, adapter.id, cmd, args, result);

  // A gate that could not run at all is a failure, never a pass. Treating a
  // missing binary as green is the exact shape of a false green (§16.3).
  const failures: Failure[] = result.spawnError
    ? [{ rule: `${adapter.id}:unavailable`, message: result.spawnError }]
    : adapter.parse(result.stdout, result.stderr, result.exitCode);

  const { shown, total } = topFailures(failures);
  const ok = result.exitCode === 0 && !result.spawnError && failures.length === 0;

  return {
    gate: adapter.id,
    ok,
    exitCode: result.exitCode,
    durationMs,
    failures: shown,
    raw,
    // Signature covers the whole failure set, not just the reported slice —
    // otherwise fixing failure 21 would look like no change at all (§9.1).
    signature: ok ? 'green' : failureSignature(failures),
    ...(total > shown.length ? {} : {}),
  };
}

export interface LadderResult {
  reports: GateReport[];
  ok: boolean;
  /** Set when the ladder stopped early; the remaining gates never ran. */
  stoppedAt?: GateId;
  skipped: GateId[];
}

/**
 * Run gates cheapest-first and stop at the first blocking failure. There is no
 * value in a twenty-minute test suite when compilation already failed, and the
 * repair loop wants the earliest signal, not the fullest one.
 */
export async function runLadder(
  adapters: readonly GateAdapter[],
  opts: RunGateOptions,
): Promise<LadderResult> {
  const reports: GateReport[] = [];
  for (const [i, adapter] of adapters.entries()) {
    const report = await runGate(adapter, opts);
    reports.push(report);
    if (!report.ok && adapter.blocking) {
      return {
        reports,
        ok: false,
        stoppedAt: adapter.id,
        skipped: adapters.slice(i + 1).map((a) => a.id),
      };
    }
  }
  return { reports, ok: reports.every((r) => r.ok), skipped: [] };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  spawnError?: string;
}

function spawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    execFile(
      cmd, args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        // ENOENT means the tool is not installed — distinct from a test failure,
        // and the distinction has to survive into the report.
        const spawnError = e && (e.code === 'ENOENT' || e.code === 'EACCES')
          ? `cannot run "${cmd}": ${e.code === 'ENOENT' ? 'command not found' : 'permission denied'}`
          : undefined;
        const timedOut = Boolean(e?.killed);
        resolve({
          stdout: stdout ?? '',
          stderr: timedOut ? `${stderr ?? ''}\ngate timed out after ${opts.timeoutMs}ms` : stderr ?? '',
          exitCode: typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          timedOut,
          ...(spawnError ? { spawnError } : {}),
        });
      },
    );
  });
}

function writeLog(
  logDir: string, gate: GateId, cmd: string, args: string[], result: SpawnResult,
): string {
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${gate}.log`);
  writeFileSync(
    path,
    [`$ ${cmd} ${args.join(' ')}`, '', '--- stdout ---', result.stdout, '--- stderr ---', result.stderr].join('\n'),
    'utf8',
  );
  return path;
}
