import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GateAdapter } from '../adapter.js';
import {
  fallbackFailure, parseCoverage, parseEslintJson, parseGitleaksJson, parseTsc, parseVitestJson,
} from '../parsers/typescript.js';

/**
 * The Node / TypeScript adapter set (§12.2). Shipping two adapter sets is what
 * proves the abstraction; this is the second one, and it exercises the same
 * hard cases as Gradle at a fraction of the test runtime.
 */

const hasPackageJson = (root: string) => existsSync(join(root, 'package.json'));

/**
 * Resolve a tool from the project's own `node_modules/.bin`, falling back to
 * PATH. Deliberately **not** `npx`: npx will fetch from the registry (or serve
 * a cached decoy of the same name) when the tool is not installed locally, so a
 * gate could execute code the repo never depended on, or report a stranger's
 * package's exit code as the project's build result.
 */
function localBin(root: string, name: string): string {
  const local = join(root, 'node_modules', '.bin', name);
  return existsSync(local) ? local : name;
}

const hasLocal = (root: string, pkg: string) => existsSync(join(root, 'node_modules', pkg));

export const compileGate: GateAdapter = {
  id: 'compile',
  level: 0,
  blocking: true,
  detect: (repo) => existsSync(join(repo.root, 'tsconfig.json')) && hasLocal(repo.root, 'typescript'),
  command: (_scope, repo) => ({
    cmd: localBin(repo.root, 'tsc'), args: ['--noEmit', '--pretty', 'false'], cwd: repo.root,
  }),
  parse: (stdout, stderr, exitCode) => {
    const failures = parseTsc(stdout, stderr);
    return failures.length > 0 || exitCode === 0 ? failures : [fallbackFailure('compile', exitCode, stderr)];
  },
  estimatedMs: () => 8_000,
};

export const lintGate: GateAdapter = {
  id: 'lint',
  level: 1,
  blocking: true,
  detect: (repo) =>
    ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc.cjs']
      .some((f) => existsSync(join(repo.root, f))) && hasLocal(repo.root, 'eslint'),
  command: (scope, repo) => ({
    cmd: localBin(repo.root, 'eslint'),
    // Lint only what changed: the diff is the unit of review, and a repo-wide
    // lint run would surface pre-existing debt the run did not cause (§12.4).
    args: ['--format', 'json', ...(scope.files.length > 0 ? scope.files : ['.'])],
    cwd: repo.root,
  }),
  parse: (stdout, stderr, exitCode) => {
    const failures = parseEslintJson(stdout);
    return failures.length > 0 || exitCode === 0 ? failures : [fallbackFailure('lint', exitCode, stderr)];
  },
  affectedBy: (files) => ({ files: files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) }),
  estimatedMs: (scope) => 1_000 + scope.files.length * 120,
};

export const unitGate: GateAdapter = {
  id: 'unit',
  level: 3,
  blocking: true,
  detect: (repo) => hasPackageJson(repo.root) && hasLocal(repo.root, 'vitest'),
  command: (_scope, repo) => ({
    cmd: localBin(repo.root, 'vitest'), args: ['run', '--reporter=json'], cwd: repo.root,
  }),
  parse: (stdout, stderr, exitCode) => {
    const failures = parseVitestJson(stdout);
    return failures.length > 0 || exitCode === 0 ? failures : [fallbackFailure('unit', exitCode, stderr)];
  },
  estimatedMs: () => 20_000,
};

/** Coverage providers vitest can drive. Without one, `--coverage` is inert. */
const COVERAGE_PROVIDERS = ['@vitest/coverage-v8', '@vitest/coverage-istanbul'];

export const DEFAULT_COVERAGE_THRESHOLD = 0.8;

export const coverageGate: GateAdapter = {
  id: 'coverage',
  level: 4,
  blocking: true,
  // Requires a provider, not just vitest: `--coverage` without one reports
  // nothing and exits zero, which would make an unmeasured repo look covered.
  detect: (repo) =>
    hasLocal(repo.root, 'vitest') && COVERAGE_PROVIDERS.some((p) => hasLocal(repo.root, p)),
  command: (_scope, repo) => {
    const ratio = repo.thresholds?.coverage ?? DEFAULT_COVERAGE_THRESHOLD;
    // Vitest takes percentages; the workflow stores a ratio.
    const percent = Math.round(ratio * 100);
    return {
      cmd: localBin(repo.root, 'vitest'),
      args: [
        'run', '--coverage',
        '--coverage.reporter=text-summary',
        `--coverage.thresholds.lines=${percent}`,
        `--coverage.thresholds.statements=${percent}`,
      ],
      cwd: repo.root,
    };
  },
  parse: (stdout, stderr, exitCode) => {
    const failures = parseCoverage(stdout, stderr);
    if (failures.length > 0) return failures;
    // A non-zero exit with no threshold message means the run itself broke —
    // a failing test, a missing provider — and that is not "covered enough".
    return exitCode === 0 ? [] : [fallbackFailure('coverage', exitCode, stderr)];
  },
  estimatedMs: () => 35_000,
};

export const secretScanGate: GateAdapter = {
  id: 'secretscan',
  level: 8,
  blocking: true,
  // Always applicable: a secret scan is not something a repo opts into.
  detect: () => true,
  command: (_scope, repo) => ({
    cmd: 'gitleaks',
    args: ['detect', '--no-git', '--report-format', 'json', '--report-path', '/dev/stdout', '--exit-code', '1'],
    cwd: repo.root,
  }),
  parse: (stdout, stderr, exitCode) => {
    const failures = parseGitleaksJson(stdout);
    if (failures.length > 0) return failures;
    // gitleaks missing from PATH exits non-zero with nothing parseable. That
    // must read as a failed gate, never as "no secrets found".
    return exitCode === 0 ? [] : [fallbackFailure('secretscan', exitCode, stderr)];
  },
  estimatedMs: () => 2_000,
};

export const NODE_ADAPTERS: GateAdapter[] = [
  compileGate, lintGate, unitGate, coverageGate, secretScanGate,
];
