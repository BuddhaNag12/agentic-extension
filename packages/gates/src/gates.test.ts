import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateAdapter } from './adapter.js';
import { GateRegistry } from './registry.js';
import { runGate, runLadder } from './runner.js';
import {
  fallbackFailure, parseEslintJson, parseGitleaksJson, parseTsc, parseVitestJson,
} from './parsers/typescript.js';
import { NODE_ADAPTERS, compileGate, lintGate, unitGate } from './adapters/node.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-gates-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const opts = () => ({ repo: { root: dir, files: [] }, scope: { files: [] }, logDir: join(dir, 'logs') });

/** Give the temp project a real toolchain by borrowing the workspace's. */
const WORKSPACE_MODULES = join(__dirname, '..', '..', '..', 'node_modules');
const linkNodeModules = () => symlinkSync(WORKSPACE_MODULES, join(dir, 'node_modules'), 'dir');

/** A stub adapter so runner behaviour is testable without a toolchain. */
const stub = (over: Partial<GateAdapter> & { id: string }): GateAdapter => ({
  level: 0,
  blocking: true,
  detect: () => true,
  command: () => ({ cmd: 'node', args: ['-e', 'process.exit(0)'], cwd: dir }),
  parse: () => [],
  ...over,
});

describe('parsers turn raw output into structure (§12.2)', () => {
  it('parses tsc diagnostics and ignores warnings', () => {
    const out = [
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(3,1): warning TS6133: 'x' is declared but never used.",
      'Found 1 error.',
    ].join('\n');
    expect(parseTsc(out, '')).toEqual([
      { file: 'src/a.ts', line: 12, rule: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
    ]);
  });

  it('parses eslint json and treats warnings as non-blocking', () => {
    const json = JSON.stringify([
      { filePath: '/repo/src/a.ts', messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 4 },
        { ruleId: 'prefer-const', severity: 1, message: 'Use const.', line: 9 },
      ] },
    ]);
    const failures = parseEslintJson(json);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ rule: 'no-unused-vars', line: 4 });
  });

  it('parses a vitest json report and keys failures on the test name', () => {
    const json = JSON.stringify({
      testResults: [{
        name: '/repo/src/a.test.ts',
        assertionResults: [
          { status: 'passed', fullName: 'adds' },
          { status: 'failed', fullName: 'subtracts', failureMessages: ['AssertionError: expected 1 to be 2\n  at line 9'] },
        ],
      }],
    });
    const failures = parseVitestJson(json);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('subtracts');
    expect(failures[0]?.file).toBe('/repo/src/a.test.ts');
  });

  it('tolerates progress output interleaved with the vitest json', () => {
    const noisy = `RUN v2.1.0\n${JSON.stringify({ testResults: [{ name: 'x', assertionResults: [{ status: 'failed', fullName: 'boom', failureMessages: ['nope'] }] }] })}\ndone`;
    expect(parseVitestJson(noisy)).toHaveLength(1);
  });

  it('never echoes the matched secret into a finding', () => {
    const json = JSON.stringify([
      { File: '.env', StartLine: 2, RuleID: 'aws-access-key', Description: 'AWS Access Key', Secret: 'AKIAIOSFODNN7EXAMPLE' },
    ]);
    const failures = parseGitleaksJson(json);
    expect(failures[0]).toMatchObject({ file: '.env', line: 2, rule: 'aws-access-key' });
    expect(JSON.stringify(failures)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('returns nothing for output it cannot parse', () => {
    expect(parseTsc('gibberish', '')).toEqual([]);
    expect(parseEslintJson('not json')).toEqual([]);
  });

  it('produces a loud failure when a tool exits non-zero with no parseable output', () => {
    const f = fallbackFailure('compile', 2, 'Segmentation fault\nmore');
    expect(f.message).toContain('exited 2');
    expect(f.message).toContain('Segmentation fault');
  });
});

describe('adapters refuse to report a broken tool as green', () => {
  it('compile turns an unparseable non-zero exit into a failure', () => {
    expect(compileGate.parse('', 'internal error', 3)).toHaveLength(1);
  });

  it('compile reports clean output with exit 0 as no failures', () => {
    expect(compileGate.parse('', '', 0)).toEqual([]);
  });

  it('lint scopes itself to changed source files', () => {
    const scope = lintGate.affectedBy!(['src/a.ts', 'README.md', 'src/b.tsx']);
    expect(scope.files).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('lint falls back to the whole repo when nothing changed', () => {
    expect(lintGate.command({ files: [] }, { root: dir, files: [] }).args).toContain('.');
  });
});

describe('registry', () => {
  it('detects only the adapters a repo supports', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    linkNodeModules();
    const detected = new GateRegistry().detect({ root: dir, files: [] }).map((a) => a.id);
    expect(detected).toContain('compile');
    expect(detected).toContain('secretscan');
    expect(detected).not.toContain('lint');   // no eslint config present
  });

  it('does not detect compile when typescript is not installed', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    // A tsconfig alone is not enough: without a local tsc the gate could only
    // run by fetching one, and a gate must never reach the network.
    expect(new GateRegistry().detect({ root: dir, files: [] }).map((a) => a.id)).not.toContain('compile');
  });

  it('orders resolved gates cheapest-first', () => {
    const { adapters } = new GateRegistry().resolve(['secretscan', 'unit', 'compile', 'lint']);
    expect(adapters.map((a) => a.id)).toEqual(['compile', 'lint', 'unit', 'secretscan']);
  });

  it('reports unknown gate ids instead of silently dropping them', () => {
    const { adapters, missing } = new GateRegistry().resolve(['compile', 'paparazzi']);
    expect(adapters.map((a) => a.id)).toEqual(['compile']);
    expect(missing).toEqual(['paparazzi']);
  });

  it('registers every Node adapter', () => {
    expect(NODE_ADAPTERS.map((a) => a.id).sort()).toEqual(['compile', 'lint', 'secretscan', 'unit']);
  });
});

describe('runner (§5 Stage 7)', () => {
  it('passes a gate whose command exits zero', async () => {
    const report = await runGate(stub({ id: 'ok' }), opts());
    expect(report).toMatchObject({ ok: true, exitCode: 0, signature: 'green' });
  });

  it('fails a gate whose command exits non-zero', async () => {
    const report = await runGate(stub({
      id: 'bad',
      command: () => ({ cmd: 'node', args: ['-e', 'process.exit(1)'], cwd: dir }),
      parse: () => [{ file: 'a.ts', line: 3, rule: 'E1', message: 'boom' }],
    }), opts());
    expect(report.ok).toBe(false);
    expect(report.signature).not.toBe('green');
  });

  it('reports a missing tool as a failed gate, not a passing one', async () => {
    const report = await runGate(stub({
      id: 'missing',
      command: () => ({ cmd: 'definitely-not-a-real-binary-xyz', args: [], cwd: dir }),
    }), opts());
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.rule).toBe('missing:unavailable');
    expect(report.failures[0]?.message).toContain('command not found');
  });

  it('never passes a gate that produced failures even on exit zero', async () => {
    const report = await runGate(stub({
      id: 'liar',
      parse: () => [{ message: 'something is wrong' }],
    }), opts());
    expect(report.ok).toBe(false);
  });

  it('writes the full log to disk and puts only the path in the report', async () => {
    const report = await runGate(stub({
      id: 'noisy',
      command: () => ({ cmd: 'node', args: ['-e', 'console.log("x".repeat(5000))'], cwd: dir }),
    }), opts());
    expect(report.raw).toContain('noisy.log');
    expect(readFileSync(report.raw!, 'utf8').length).toBeGreaterThan(5000);
    expect(JSON.stringify(report).length).toBeLessThan(2000);
  });

  it('caps reported failures at 20 but signs the whole set', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.ts`, message: `error ${i}` }));
    const a = await runGate(stub({ id: 'many', parse: () => many }), opts());
    const b = await runGate(stub({ id: 'many', parse: () => many.slice(0, 49) }), opts());

    expect(a.failures).toHaveLength(20);
    // Fixing failure 50 must change the signature, or repair looks like thrash.
    expect(a.signature).not.toBe(b.signature);
  });

  it('times out a gate that never exits', async () => {
    const report = await runGate(
      stub({ id: 'hang', command: () => ({ cmd: 'node', args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir }) }),
      { ...opts(), timeoutMs: 300 },
    );
    expect(report.ok).toBe(false);
    expect(readFileSync(report.raw!, 'utf8')).toContain('timed out');
  });
});

describe('the ladder fails fast (§12.1)', () => {
  const pass = (id: string, level: number) => stub({ id, level });
  const fail = (id: string, level: number) => stub({
    id, level,
    command: () => ({ cmd: 'node', args: ['-e', 'process.exit(1)'], cwd: dir }),
    parse: () => [{ message: `${id} failed` }],
  });

  it('stops at the first blocking failure and names what it skipped', async () => {
    const result = await runLadder([pass('compile', 0), fail('lint', 1), pass('unit', 3)], opts());
    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('lint');
    expect(result.skipped).toEqual(['unit']);
    expect(result.reports).toHaveLength(2);
  });

  it('continues past a non-blocking failure', async () => {
    const warn = { ...fail('bundlesize', 9), blocking: false };
    const result = await runLadder([pass('compile', 0), warn, pass('unit', 3)], opts());
    expect(result.reports).toHaveLength(3);
    expect(result.ok).toBe(false);
  });

  it('passes only when every gate passes', async () => {
    const result = await runLadder([pass('compile', 0), pass('lint', 1)], opts());
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([]);
  });
});

describe('a real repository', () => {
  it('compiles a valid file and reports the error in a broken one', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'commonjs' },
      include: ['src'],
    }));
    writeFileSync(join(dir, 'src/good.ts'), 'export const x: number = 1;\n');
    linkNodeModules();

    const green = await runGate(compileGate, opts());
    expect(green.ok).toBe(true);

    writeFileSync(join(dir, 'src/bad.ts'), 'export const y: number = "not a number";\n');
    const red = await runGate(compileGate, opts());
    expect(red.ok).toBe(false);
    expect(red.failures[0]).toMatchObject({ rule: 'TS2322' });
    expect(red.failures[0]?.file).toContain('bad.ts');
  }, 60_000);
});
