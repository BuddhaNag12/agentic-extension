import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from './log.js';
import { emptyMigrationCount, migrateRawEvent } from './migrate.js';
import { replay } from './replay.js';

/**
 * Reading a log written before schema 2.0.0. The failure mode this guards
 * against is silent: `RunEvent.safeParse` discards a line whose phase name no
 * longer exists, so narrowing the enum without a migration would have quietly
 * erased the phase history of every run already on disk.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-migrate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const logPath = () => join(dir, 'run', 'events.jsonl');

/** Write raw lines, bypassing `append` — a legacy log is not writable now. */
function writeLegacy(lines: unknown[]): void {
  const log = EventLog.open(logPath());
  log.append({ t: 'log', level: 'info', message: 'legacy log' });
  for (const [i, line] of lines.entries()) {
    appendFileSync(logPath(), `${JSON.stringify({ seq: i + 1, at: 1_000 + i, ...(line as object) })}\n`, 'utf8');
  }
}

describe('legacy phase names become steps', () => {
  const cases: [string, string][] = [
    ['harvest', 'harvest'],
    ['spec', 'draft_spec'],
    ['clarify', 'questions'],
    ['plan', 'draft_plan'],
    ['decompose', 'decompose'],
    ['implement', 'implement'],
    ['verify', 'verify'],
    ['repair', 'repair'],
    ['review', 'auto_review'],
    ['human_review', 'human_review'],
  ];

  for (const [legacy, step] of cases) {
    it(`maps phase "${legacy}" to step "${step}"`, () => {
      const out = migrateRawEvent({ t: 'phase_entered', phase: legacy, seq: 0, at: 1 });
      expect(out).toMatchObject({ t: 'step_entered', step });
      expect(out).not.toHaveProperty('phase');
    });
  }

  it('leaves intake and ship as phases', () => {
    expect(migrateRawEvent({ t: 'phase_entered', phase: 'intake', seq: 0, at: 1 }))
      .toMatchObject({ t: 'phase_entered', phase: 'intake' });
    expect(migrateRawEvent({ t: 'phase_entered', phase: 'ship', seq: 0, at: 1 }))
      .toMatchObject({ t: 'phase_entered', phase: 'ship' });
  });

  it('folds the old terminal "done" phase into ship', () => {
    expect(migrateRawEvent({ t: 'phase_entered', phase: 'done', seq: 0, at: 1 }))
      .toMatchObject({ t: 'phase_entered', phase: 'ship' });
  });

  it('drops a retired phase and says so rather than losing it quietly', () => {
    const count = emptyMigrationCount();
    expect(migrateRawEvent({ t: 'phase_entered', phase: 'wait_for_ci', seq: 0, at: 1 }, count))
      .toBeUndefined();
    expect(count.dropped).toBe(1);
  });

  it('migrates the phase recorded inside a question', () => {
    const out = migrateRawEvent({
      t: 'question_asked', seq: 0, at: 1,
      question: { id: 'Q1', phase: 'clarify', question: 'which flag?' },
    }) as { question: { phase: string } };
    expect(out.question.phase).toBe('context');
  });

  it('leaves an event it does not recognize untouched', () => {
    const raw = { t: 'cost', usd: 1, seq: 0, at: 1 };
    expect(migrateRawEvent(raw)).toBe(raw);
  });
});

describe('a pre-2.0.0 log still replays', () => {
  it('reconstructs the phase board from migrated steps', () => {
    writeLegacy([
      { t: 'run_created', runId: '11111111-1111-4111-8111-111111111111', ticketKey: 'PAY-1', branch: 'agentflow/PAY-1' },
      { t: 'phase_entered', phase: 'intake' },
      { t: 'phase_entered', phase: 'harvest' },
      { t: 'phase_entered', phase: 'spec' },
      { t: 'phase_entered', phase: 'clarify' },
      { t: 'phase_entered', phase: 'plan' },
      { t: 'phase_entered', phase: 'implement' },
      { t: 'phase_entered', phase: 'verify' },
      { t: 'phase_entered', phase: 'review' },
      { t: 'phase_entered', phase: 'human_review' },
      { t: 'phase_entered', phase: 'ship' },
      { t: 'phase_entered', phase: 'done' },
      { t: 'status_changed', status: 'succeeded' },
    ]);

    const log = EventLog.open(logPath());
    const events = log.readAll();
    const s = replay(events);

    // Nothing was dropped: every legacy phase name landed somewhere.
    expect(log.migrations.dropped).toBe(0);
    // Eight legacy phases became steps, and `done` folded into ship. `intake`
    // and `ship` were already current, so they are not counted.
    expect(log.migrations.migrated).toBe(9);
    expect(s.phasesVisited).toEqual([
      'intake', 'context', 'plan', 'build', 'review', 'ship',
    ]);
    expect(s.stepsVisited).toEqual([
      'harvest', 'draft_spec', 'questions', 'draft_plan',
      'implement', 'verify', 'auto_review', 'human_review',
    ]);
    expect(s.status).toBe('succeeded');
    expect(s.ticketKey).toBe('PAY-1');
    // The last event was a bare phase change, so no step is current — never a
    // step left over from the phase before it.
    expect(s.step).toBeUndefined();
  });

  it('does not rewrite the log it migrated', () => {
    writeLegacy([{ t: 'phase_entered', phase: 'harvest' }]);
    const before = EventLog.open(logPath()).readAll();
    expect(before[1]).toMatchObject({ t: 'step_entered', step: 'harvest' });

    // Re-reading migrates again from the same bytes: the append-only log is
    // the audit trail, and rewriting history to fit a newer schema would
    // destroy the thing it exists to preserve.
    const again = EventLog.open(logPath());
    expect(again.readAll()).toEqual(before);
    expect(again.migrations.migrated).toBe(1);
  });

  it('still tolerates a torn final line alongside a migration', () => {
    writeLegacy([{ t: 'phase_entered', phase: 'implement' }]);
    appendFileSync(logPath(), '{"t":"phase_entered","phase":"ver');

    const log = EventLog.open(logPath());
    expect(log.readAll()).toHaveLength(2);
  });
});
