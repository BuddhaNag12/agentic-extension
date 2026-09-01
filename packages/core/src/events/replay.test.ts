import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { NewRunEvent, RunEvent } from '@agentflow/protocol';
import { EventLog } from './log.js';
import { apply, emptyState, replay } from './replay.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentflow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const logPath = () => join(dir, 'run', 'events.jsonl');

describe('EventLog', () => {
  it('stamps monotonically increasing sequence numbers', () => {
    const log = EventLog.open(logPath());
    const a = log.append({ t: 'phase_entered', phase: 'intake' });
    const b = log.append({ t: 'phase_entered', phase: 'harvest' });
    expect([a.seq, b.seq]).toEqual([0, 1]);
  });

  it('recovers the next sequence number after a restart', () => {
    const first = EventLog.open(logPath());
    first.append({ t: 'phase_entered', phase: 'intake' });
    first.append({ t: 'phase_entered', phase: 'harvest' });

    const reopened = EventLog.open(logPath());
    expect(reopened.nextSeq).toBe(2);
    expect(reopened.append({ t: 'phase_entered', phase: 'spec' }).seq).toBe(2);
  });

  it('tolerates a truncated final line from a killed process', () => {
    const log = EventLog.open(logPath());
    log.append({ t: 'phase_entered', phase: 'intake' });
    appendFileSync(logPath(), '{"t":"phase_entered","phase":"har');

    const reopened = EventLog.open(logPath());
    expect(reopened.readAll()).toHaveLength(1);
    expect(reopened.nextSeq).toBe(1);
  });

  it('publishes appended events to subscribers', () => {
    const log = EventLog.open(logPath());
    const seen: RunEvent[] = [];
    const off = log.onEvent((e) => seen.push(e));
    log.append({ t: 'log', level: 'info', message: 'hello' });
    off();
    log.append({ t: 'log', level: 'info', message: 'unheard' });
    expect(seen).toHaveLength(1);
  });

  it('rejects an event that does not match the schema', () => {
    const log = EventLog.open(logPath());
    expect(() => log.append({ t: 'phase_entered', phase: 'nonsense' } as unknown as NewRunEvent)).toThrow();
  });
});

describe('replay', () => {
  it('derives phase, cost and changed files from the log alone', () => {
    const log = EventLog.open(logPath());
    log.append({ t: 'run_created', runId: '11111111-1111-4111-8111-111111111111', ticketKey: 'PAY-1', branch: 'agentflow/PAY-1' });
    log.append({ t: 'phase_entered', phase: 'implement' });
    log.append({ t: 'status_changed', status: 'running' });
    log.append({ t: 'file_changed', path: 'src/a.ts', op: 'create', hunks: 2 });
    log.append({ t: 'file_changed', path: 'src/a.ts', op: 'modify', hunks: 1 });
    log.append({ t: 'cost', usd: 0.5, inputTokens: 100, outputTokens: 20, model: 'sonnet' });
    log.append({ t: 'cost', usd: 0.25, inputTokens: 50, outputTokens: 10, model: 'sonnet' });

    const s = replay(log.readAll());
    expect(s.ticketKey).toBe('PAY-1');
    expect(s.phase).toBe('implement');
    expect(s.status).toBe('running');
    expect(s.cost).toEqual({ usd: 0.75, inputTokens: 150, outputTokens: 30 });
    // Created-then-modified still reads as created against the baseline.
    expect(s.changedFiles['src/a.ts']).toEqual({ path: 'src/a.ts', op: 'create', hunks: 3 });
  });

  it('clears questions and approvals once resolved', () => {
    const log = EventLog.open(logPath());
    const question = {
      id: 'Q1', question: 'Which flag?', whyItMatters: 'scope',
      alreadyChecked: ['grep flags'], allowFreeText: true, blocking: true,
      confidenceWithoutAnswer: 0.3, phase: 'clarify' as const,
    };
    log.append({ t: 'question_asked', question });
    log.append({ t: 'approval_requested', gate: 'G1', approvalId: 'A1', artifactKind: 'spec', artifactVersion: 1 });
    expect(replay(log.readAll()).openQuestions).toHaveLength(1);

    log.append({ t: 'question_answered', questionId: 'Q1', answer: { questionId: 'Q1', choice: 'yes', deferred: false, answeredBy: 'me', answeredAt: 1 } });
    log.append({ t: 'approval_decided', gate: 'G1', approvalId: 'A1', decision: 'approve', decidedBy: 'me' });

    const s = replay(log.readAll());
    expect(s.openQuestions).toHaveLength(0);
    expect(s.pendingApprovals).toHaveLength(0);
    expect(s.answeredQuestions).toEqual(['Q1']);
  });
});

describe('property: a snapshot is only a cache (§3.3)', () => {
  const anyEvent = fc.oneof(
    fc.constantFrom('intake', 'harvest', 'spec', 'implement', 'verify', 'review').map(
      (phase) => ({ t: 'phase_entered', phase }) as NewRunEvent,
    ),
    fc.constantFrom('queued', 'running', 'waiting_human', 'blocked').map(
      (status) => ({ t: 'status_changed', status }) as NewRunEvent,
    ),
    fc.record({ path: fc.constantFrom('a.ts', 'b.ts', 'c.ts'), hunks: fc.integer({ min: 0, max: 9 }) }).map(
      ({ path, hunks }) => ({ t: 'file_changed', path, op: 'modify', hunks }) as NewRunEvent,
    ),
    fc.record({ usd: fc.float({ min: 0, max: 1, noNaN: true }) }).map(
      ({ usd }) => ({ t: 'cost', usd, inputTokens: 1, outputTokens: 1, model: 'sonnet' }) as NewRunEvent,
    ),
  );

  it('replaying from a mid-point snapshot equals folding the whole log', () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 60 }), fc.nat(), (events, cut) => {
        const log = EventLog.open(join(dir, `p-${Math.random()}`, 'events.jsonl'));
        const stamped = events.map((e) => log.append(e));

        const split = stamped.length === 0 ? 0 : cut % (stamped.length + 1);
        const snapshot = replay(stamped.slice(0, split));
        const incremental = stamped.slice(split).reduce(apply, snapshot);

        expect(incremental).toEqual(replay(stamped));
      }),
      { numRuns: 60 },
    );
  });

  it('apply is total — no event sequence throws', () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
        const log = EventLog.open(join(dir, `t-${Math.random()}`, 'events.jsonl'));
        const stamped = events.map((e) => log.append(e));
        expect(() => stamped.reduce(apply, emptyState())).not.toThrow();
      }),
      { numRuns: 40 },
    );
  });
});
