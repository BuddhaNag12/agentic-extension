import { isTestFile } from './paths.js';
import { ALLOW, deny, type GuardrailDecision } from './types.js';

/**
 * The §9.3 anti-patterns: every one of these is a way for a repair loop to
 * report success while making things strictly worse. They are enforced by
 * hooks and diff analysis rather than by prompt instruction, because the hooks
 * hold when the prompt is ignored.
 */

/** Markers that disable a test rather than fix it. */
const SKIP_MARKERS: { re: RegExp; label: string }[] = [
  { re: /@Ignore\b/, label: '@Ignore' },
  { re: /@Disabled\b/, label: '@Disabled' },
  { re: /\b(?:it|test|describe)\.skip\s*\(/, label: '.skip(' },
  { re: /\b(?:xit|xdescribe|xtest)\s*\(/, label: 'xit(' },
  { re: /\b(?:it|test)\.todo\s*\(/, label: '.todo(' },
  { re: /@pytest\.mark\.skip/, label: '@pytest.mark.skip' },
  { re: /\bt\.Skip\s*\(/, label: 't.Skip(' },
  { re: /\/\/\s*nolint/, label: '// nolint' },
];

const ASSERTION = /\b(?:assert\w*|expect|should|verify|require\.\w+)\s*[({]/g;

export interface EditProposal {
  /** Worktree-relative. */
  path: string;
  before: string;
  after: string;
}

/**
 * Pre-write check on a single edit. Deliberately narrow: it only refuses what
 * can be established from the file itself, so it never blocks a legitimate fix.
 */
export function checkEdit(
  edit: EditProposal,
  failingTestFiles: readonly string[],
): GuardrailDecision {
  if (!isTestFile(edit.path)) return ALLOW;

  const isFailing = failingTestFiles.some((f) => f === edit.path || f.endsWith(`/${edit.path}`) || edit.path.endsWith(`/${f}`));

  const addedSkips = SKIP_MARKERS.filter(({ re }) => countMatches(edit.after, re) > countMatches(edit.before, re));
  if (addedSkips.length > 0 && isFailing) {
    return deny('antipattern.skip_failing_test',
      `this adds ${addedSkips.map((s) => s.label).join(', ')} to "${edit.path}", which is in the failing set. ` +
      'Disabling a failing test is not a fix. Make the test pass, or explain via ask_human why the test itself is wrong.');
  }

  // Checked before the assertion count, which would also catch this but name
  // it less precisely — the reason is fed back to the agent, so it should say
  // what actually happened.
  if (isFailing && edit.after.trim().length === 0) {
    return deny('antipattern.deleted_failing_test',
      `this empties "${edit.path}", which is in the failing set. Deleting a failing test is never the fix.`);
  }

  const before = countMatches(edit.before, ASSERTION);
  const after = countMatches(edit.after, ASSERTION);
  if (isFailing && after < before) {
    return deny('antipattern.weakened_assertion',
      `this removes ${before - after} assertion(s) from "${edit.path}", which is in the failing set. ` +
      'Weakening the test hides the defect rather than fixing it.');
  }

  return ALLOW;
}

export interface DiffFile {
  path: string;
  before: string;
  after: string;
}

export interface Finding {
  rule: string;
  severity: 'blocker' | 'major' | 'minor';
  file: string;
  claim: string;
}

/**
 * Post-attempt diff analysis. These need the whole change set rather than one
 * edit, so they surface as blocking review findings instead of denied calls.
 */
export function analyzeDiff(files: readonly DiffFile[], failingTestFiles: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const productionChanged = files.some((f) => !isTestFile(f.path) && f.before !== f.after);
  const failing = new Set(failingTestFiles);

  for (const file of files) {
    if (file.before === file.after) continue;

    // Tests edited while production code stands still: the change set can only
    // be moving the goalposts.
    if (isTestFile(file.path) && !productionChanged && failing.has(file.path)) {
      findings.push({
        rule: 'antipattern.test_only_change', severity: 'blocker', file: file.path,
        claim: 'a failing test was modified while its production code was left unchanged',
      });
    }

    // A catch that swallows: added, and containing nothing but a log or nothing.
    if (addedSwallowingCatch(file.before, file.after)) {
      findings.push({
        rule: 'antipattern.swallowed_exception', severity: 'blocker', file: file.path,
        claim: 'a new catch block discards the error instead of handling it',
      });
    }
  }

  // A literal that appears in a failing test's fixtures and then shows up in
  // production code is the classic "hardcode until the test goes green".
  const testLiterals = new Set(
    files.filter((f) => isTestFile(f.path)).flatMap((f) => distinctiveLiterals(f.before + f.after)),
  );
  for (const file of files) {
    if (isTestFile(file.path) || file.before === file.after) continue;
    for (const literal of distinctiveLiterals(added(file.before, file.after))) {
      if (testLiterals.has(literal)) {
        findings.push({
          rule: 'antipattern.hardcoded_to_fixture', severity: 'blocker', file: file.path,
          claim: `production code now contains ${literal}, a literal that appears in the test fixtures`,
        });
        break;
      }
    }
  }

  return findings;
}

/** Scope explosion is a count, checked before the write rather than after. */
export function checkTouchBudget(
  filesTouched: ReadonlySet<string>,
  candidate: string,
  max: number,
): GuardrailDecision {
  if (filesTouched.has(candidate) || filesTouched.size < max) return ALLOW;
  return deny('antipattern.scope_explosion',
    `this task has already touched ${filesTouched.size} files, its limit. ` +
    'If the change genuinely needs more, stop and say so via ask_human rather than widening scope.');
}

function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (text.match(global) ?? []).length;
}

function added(before: string, after: string): string {
  const old = new Set(before.split('\n').map((l) => l.trim()));
  return after.split('\n').filter((l) => !old.has(l.trim())).join('\n');
}

function addedSwallowingCatch(before: string, after: string): boolean {
  const isSwallowing = (text: string) =>
    countMatches(text, /catch\s*\([^)]*\)\s*\{\s*\}/g)
    + countMatches(text, /catch\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*\s*)*(?:console\.\w+|log(?:ger)?\.\w+)\([^;]*\);?\s*\}/g)
    + countMatches(text, /except[^:]*:\s*pass\b/g);
  return isSwallowing(after) > isSwallowing(before);
}

/**
 * Literals distinctive enough that sharing one between a test fixture and
 * production code is evidence rather than coincidence. Short strings and small
 * numbers appear everywhere and would produce constant false positives.
 */
function distinctiveLiterals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["'`]([^"'`\n]{8,64})["'`]/g)) {
    const value = m[1]!;
    if (/^[\s./\\-]*$/.test(value)) continue;
    if (/^(?:https?:\/\/)?[\w.]+\/[\w./-]*$/.test(value) && !/\d{4,}/.test(value)) continue;
    out.push(`"${value}"`);
  }
  for (const m of text.matchAll(/\b(\d{5,})\b/g)) out.push(m[1]!);
  return out;
}
