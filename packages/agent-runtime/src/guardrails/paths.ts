import { isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

/**
 * Path policy (§7.4 Layer 1, §5 Stage 5 guardrails). The concrete, enforceable
 * version of "stay in scope" — enforced by code, not by prompt instruction.
 */

export interface PathVerdict {
  ok: boolean;
  reason?: string;
  rule?: string;
}

/** Files whose modification always needs a human (§9.3 silent dependency add). */
export const DEPENDENCY_MANIFESTS = [
  '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle*', '**/libs.versions.toml',
  '**/pom.xml', '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum',
  '**/requirements*.txt', '**/pyproject.toml', '**/Gemfile*',
];

/** Never written by an agent, whatever the workflow says. */
export const ALWAYS_FORBIDDEN = [
  '**/*.pem', '**/*.key', '**/*.keystore', '**/*.p12', '**/*.jks',
  '**/.env', '**/.env.*', '**/local.properties',
  '**/.git/**', '**/node_modules/**',
];

/** Build output — editing it means the agent is treating generated code as source. */
export const GENERATED = [
  '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/target/**',
  '**/*.min.js', '**/*.generated.*', '**/*_pb2.py', '**/generated/**',
];

const matcher = (globs: readonly string[]) =>
  globs.length > 0 ? picomatch(globs as string[], { dot: true }) : () => false;

/**
 * Resolve a path the agent supplied to a worktree-relative path, refusing
 * anything that escapes. Absolute paths and `../` traversal are the two ways a
 * write reaches outside the run's isolation.
 */
export function toWorktreeRelative(worktree: string, candidate: string): PathVerdict & { path?: string } {
  const root = resolve(worktree);
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, abs);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false, rule: 'path.outside_worktree',
      reason: `"${candidate}" resolves outside the run's worktree. Every edit must stay inside ${root}.`,
    };
  }
  return { ok: true, path: rel.split(sep).join('/') };
}

export interface PathPolicy {
  worktree: string;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  allowDependencyChanges: boolean;
}

export function checkWritePath(policy: PathPolicy, candidate: string): PathVerdict & { path?: string } {
  const resolved = toWorktreeRelative(policy.worktree, candidate);
  if (!resolved.ok) return resolved;
  const path = resolved.path!;

  if (matcher(ALWAYS_FORBIDDEN)(path)) {
    return {
      ok: false, rule: 'path.always_forbidden',
      reason: `"${path}" is a credential or VCS path that is never writable. If the task genuinely needs it, ask the human via ask_human.`,
    };
  }
  if (matcher(policy.forbiddenPaths)(path)) {
    return {
      ok: false, rule: 'path.forbidden',
      reason: `"${path}" is forbidden by this run's guardrails.`,
    };
  }
  if (matcher(GENERATED)(path)) {
    return {
      ok: false, rule: 'path.generated',
      reason: `"${path}" looks generated. Change the source that produces it, not the output.`,
    };
  }
  if (!policy.allowDependencyChanges && matcher(DEPENDENCY_MANIFESTS)(path)) {
    return {
      ok: false, rule: 'path.dependency_manifest',
      reason:
        `"${path}" is a dependency manifest. Adding a dependency needs human approval — ` +
        'solve it with what the repo already has, or ask via ask_human naming the package and why.',
    };
  }
  // An empty allowlist means "anything not otherwise forbidden": a phase with
  // no predicted touch set must not be unable to write at all.
  if (policy.allowedPaths.length > 0 && !matcher(policy.allowedPaths)(path)) {
    return {
      ok: false, rule: 'path.not_in_scope',
      reason:
        `"${path}" is outside this task's predicted touch set. If the change genuinely ` +
        'requires it, say so and ask rather than widening scope silently.',
    };
  }
  return { ok: true, path };
}

export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(path)
    || /\.(?:test|spec)\.[jt]sx?$/.test(path)
    || /Test\.(?:kt|java|swift)$/.test(path)
    || /_test\.(?:go|py)$/.test(path)
    || /(?:^|\/)test_[^/]+\.py$/.test(path);
}
