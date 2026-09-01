import type { Failure } from '@agentflow/protocol';

/**
 * Parsers for the Node/TypeScript adapter set. Each turns raw tool output into
 * structured failures; the fixtures in the tests are real captured output, so a
 * change in a tool's format shows up as a failing test rather than as an empty
 * failure list that silently reads as "green" (§12.7).
 */

/** `src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.` */
const TSC_LINE = /^(?<file>[^(]+)\((?<line>\d+),(?<col>\d+)\):\s+(?<sev>error|warning)\s+(?<rule>TS\d+):\s+(?<message>.*)$/;

export function parseTsc(stdout: string, stderr: string): Failure[] {
  const out: Failure[] = [];
  for (const raw of `${stdout}\n${stderr}`.split('\n')) {
    const m = TSC_LINE.exec(raw.trim());
    if (!m?.groups) continue;
    if (m.groups['sev'] !== 'error') continue;
    out.push({
      file: m.groups['file']!,
      line: Number(m.groups['line']),
      rule: m.groups['rule']!,
      message: m.groups['message']!,
    });
  }
  return out;
}

interface EslintFile {
  filePath: string;
  messages: { ruleId: string | null; severity: number; message: string; line?: number }[];
}

/** `eslint --format json`. Warnings are not failures; only severity 2 blocks. */
export function parseEslintJson(stdout: string): Failure[] {
  const files = safeJson<EslintFile[]>(stdout);
  if (!Array.isArray(files)) return [];
  const out: Failure[] = [];
  for (const file of files) {
    for (const m of file.messages ?? []) {
      if (m.severity !== 2) continue;
      out.push({
        file: file.filePath,
        ...(m.line !== undefined ? { line: m.line } : {}),
        rule: m.ruleId ?? 'eslint',
        message: m.message,
      });
    }
  }
  return out;
}

interface VitestJson {
  testResults?: {
    name?: string;
    assertionResults?: {
      status: string;
      title?: string;
      fullName?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/** `vitest --reporter=json`. */
export function parseVitestJson(stdout: string): Failure[] {
  const report = safeJson<VitestJson>(extractJson(stdout));
  const out: Failure[] = [];
  for (const suite of report?.testResults ?? []) {
    for (const test of suite.assertionResults ?? []) {
      if (test.status !== 'failed') continue;
      const first = test.failureMessages?.[0] ?? 'test failed';
      out.push({
        ...(suite.name ? { file: suite.name } : {}),
        rule: 'test',
        // The test's name is the stable part of the identity; the assertion
        // text moves around and would fracture the §9.1 signature.
        message: `${test.fullName ?? test.title ?? 'unknown test'}: ${firstLine(first)}`,
      });
    }
  }
  return out;
}

/** `gitleaks detect --report-format json`. Any finding is blocking. */
export function parseGitleaksJson(stdout: string): Failure[] {
  const findings = safeJson<{ File?: string; StartLine?: number; RuleID?: string; Description?: string }[]>(stdout);
  if (!Array.isArray(findings)) return [];
  return findings.map((f) => ({
    ...(f.File ? { file: f.File } : {}),
    ...(f.StartLine !== undefined ? { line: f.StartLine } : {}),
    rule: f.RuleID ?? 'secret',
    // Never echo the matched secret itself into an event log (§14).
    message: f.Description ?? 'potential secret detected',
  }));
}

/**
 * A tool that emits no machine-readable output still has to fail loudly.
 * Returning an empty failure list on a non-zero exit would let the runner
 * report "no failures" for a gate that did not pass.
 */
export function fallbackFailure(gate: string, exitCode: number, stderr: string): Failure {
  return {
    rule: `${gate}:unparsed`,
    message: `${gate} exited ${exitCode} and produced no parseable output: ${firstLine(stderr) || '(no stderr)'}`,
  };
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 300);
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Test runners interleave progress output with the JSON report. */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
