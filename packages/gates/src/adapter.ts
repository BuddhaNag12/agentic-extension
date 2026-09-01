import type { Failure, GateId } from '@agentflow/protocol';

/**
 * The gate adapter interface (§12.2). Every gate is a command plus a parser.
 *
 * The parser is the part that matters. Feeding 4,000 lines of build output back
 * to a model burns context and buries the signal; a parser turns it into
 * `{file, line, rule, message}` tuples, of which the model sees the top 20.
 */

export interface RepoContext {
  root: string;
  files: string[];
}

export interface Scope {
  /** Changed files this run touched, repo-relative. */
  files: string[];
  /** Modules or packages derived from those files, when the adapter maps them. */
  targets?: string[];
}

export interface GateCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface GateAdapter {
  id: GateId;
  /** Ladder level (§12.1). The runner orders by this, cheapest first. */
  level: number;
  blocking: boolean;
  /** Auto-detect from build files. Auto-detection that cannot be overridden is
   *  worse than none, so `.agentflow/gates.yaml` always wins over this. */
  detect(repo: RepoContext): boolean;
  command(scope: Scope, repo: RepoContext): GateCommand;
  parse(stdout: string, stderr: string, exitCode: number): Failure[];
  /** Map changed files to the minimal scope this gate needs to run. */
  affectedBy?(files: string[]): Scope;
  estimatedMs?(scope: Scope): number;
}

/** Cap what reaches a model. The count is reported separately (§5 Stage 7). */
export const MAX_REPORTED_FAILURES = 20;

export function topFailures(failures: readonly Failure[]): { shown: Failure[]; total: number } {
  return { shown: failures.slice(0, MAX_REPORTED_FAILURES), total: failures.length };
}
