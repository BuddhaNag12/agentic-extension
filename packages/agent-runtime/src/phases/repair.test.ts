import { describe, expect, it } from 'vitest';
import { failingTestFilesFrom, rungFor } from './repair.js';

/**
 * §11.2's ladder is about context and model, not about trying harder — an
 * identical retry is the definition of the thrash the budget exists to stop.
 */

describe('the escalation ladder (§11.2)', () => {
  it('widens, then rethinks, rather than repeating the same attempt', () => {
    expect(rungFor(1)).toBe('local');
    expect(rungFor(2)).toBe('widen');
    expect(rungFor(3)).toBe('rethink');
  });

  it('stays on the last rung it owns — 4 and 5 are the machine\'s', () => {
    // Rung 4 rewinds and replans, rung 5 parks for a human. Both leave the
    // step, so they are transitions rather than another attempt here.
    expect(rungFor(4)).toBe('rethink');
    expect(rungFor(99)).toBe('rethink');
  });

  it('treats a zero or negative attempt as the first', () => {
    expect(rungFor(0)).toBe('local');
    expect(rungFor(-1)).toBe('local');
  });
});

describe('naming the failing tests (§11.3)', () => {
  // The guardrail refuses edits that strip assertions from a *failing* test,
  // and it cannot know which those are unless something tells it. Nothing did
  // — the field was plumbed through every phase and never populated — so the
  // rule was inert exactly where it matters: a red gate is when deleting the
  // test is tempting.
  it('picks test files out of the failure set by name', () => {
    const files = failingTestFilesFrom([
      { file: 'src/cart/total.test.ts', line: 12, message: 'expected 3 to be 4' },
      { file: 'src/cart/total.ts', line: 7, message: 'TS2322' },
      { file: 'src/checkout/Empty.spec.tsx', message: 'snapshot mismatch' },
    ]);
    expect(files).toEqual(['src/cart/total.test.ts', 'src/checkout/Empty.spec.tsx']);
  });

  it('picks them out by directory too', () => {
    expect(failingTestFilesFrom([
      { file: 'test/helpers/setup.ts', message: 'boom' },
      { file: '__tests__/cart.ts', message: 'boom' },
      { file: 'src/index.ts', message: 'boom' },
    ])).toEqual(['test/helpers/setup.ts', '__tests__/cart.ts']);
  });

  it('deduplicates, so one file failing twenty assertions is named once', () => {
    expect(failingTestFilesFrom([
      { file: 'a.test.ts', line: 1, message: 'x' },
      { file: 'a.test.ts', line: 2, message: 'y' },
    ])).toEqual(['a.test.ts']);
  });

  it('returns nothing when no failure names a file', () => {
    // A compile error with no file, or a gate that could not run at all.
    expect(failingTestFilesFrom([{ message: 'gitleaks: command not found' }])).toEqual([]);
  });
});
