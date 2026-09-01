import { describe, expect, it } from 'vitest';
import type { Failure } from '@agentflow/protocol';
import { classifyAttempt, failureSignature, normalizeMessage, shouldEscalate } from './signature.js';

const f = (message: string, file?: string, rule?: string): Failure =>
  ({ message, ...(file ? { file } : {}), ...(rule ? { rule } : {}) });

describe('normalization', () => {
  it('strips line numbers, addresses, timestamps and durations', () => {
    expect(normalizeMessage('Failed at 0x7ffee in 412ms on 2026-01-02T03:04:05Z'))
      .toBe(normalizeMessage('Failed at 0xdeadbe in 88ms on 2026-09-09T11:22:33Z'));
  });

  it('strips temp paths that differ per run', () => {
    expect(normalizeMessage('cannot read /tmp/build-abc/x'))
      .toBe(normalizeMessage('cannot read /tmp/build-zzz/y'));
  });
});

describe('failureSignature', () => {
  it('is order-independent', () => {
    const a = [f('boom', 'A.kt', 'E1'), f('bang', 'B.kt', 'E2')];
    expect(failureSignature(a)).toBe(failureSignature([...a].reverse()));
  });

  it('ignores line-number churn — moving code is not progress', () => {
    expect(failureSignature([f('expected true at line 42', 'A.kt')]))
      .toBe(failureSignature([f('expected true at line 87', 'A.kt')]));
  });

  it('separates the same message in different files', () => {
    expect(failureSignature([f('boom', 'A.kt')])).not.toBe(failureSignature([f('boom', 'B.kt')]));
  });

  it('reports green for an empty failure set', () => {
    expect(failureSignature([])).toBe('green');
  });

  it('deduplicates identical failures', () => {
    expect(failureSignature([f('boom', 'A.kt'), f('boom', 'A.kt')])).toBe(failureSignature([f('boom', 'A.kt')]));
  });
});

describe('classifyAttempt (§9.1)', () => {
  it('flags an identical consecutive result as a repeat', () => {
    const v = classifyAttempt(['sigA'], 'sigA');
    expect(v).toEqual({ kind: 'repeat', signature: 'sigA' });
    expect(shouldEscalate(v)).toBe(true);
  });

  it('flags a return to an earlier state as oscillation', () => {
    const v = classifyAttempt(['sigA', 'sigB'], 'sigA');
    expect(v).toEqual({ kind: 'oscillation', signature: 'sigA' });
    expect(shouldEscalate(v)).toBe(true);
  });

  it('treats a new signature as progress', () => {
    const v = classifyAttempt(['sigA', 'sigB'], 'sigC');
    expect(v).toEqual({ kind: 'progress' });
    expect(shouldEscalate(v)).toBe(false);
  });

  it('never escalates on green', () => {
    expect(shouldEscalate(classifyAttempt(['green'], 'green'))).toBe(false);
  });

  it('walks the doc’s worked example: A A B A', () => {
    const kinds: string[] = [];
    const history: string[] = [];
    for (const sig of ['A', 'A', 'B', 'A']) {
      kinds.push(classifyAttempt(history, sig).kind);
      history.push(sig);
    }
    expect(kinds).toEqual(['progress', 'repeat', 'progress', 'oscillation']);
  });
});
