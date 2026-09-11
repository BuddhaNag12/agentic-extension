import { PHASE_OF_STEP, type Phase, type Step } from '@agentflow/protocol';

/**
 * Reading a log written before schema 2.0.0 (§3.3).
 *
 * The 2.0.0 vocabulary is §5.1's seven phases plus a `Step`. Ten of the old
 * fourteen phase names are steps now, so a legacy `phase_entered` becomes a
 * `step_entered` — which carries strictly more information, since a step
 * implies its phase through `PHASE_OF_STEP`.
 *
 * Migration happens on read and is never written back. The log is append-only
 * and the source of truth for the audit trail (§3.3); rewriting history to fit
 * a newer schema would destroy the thing it exists to preserve.
 */

/** Legacy phase names that are now steps, and which step each became. */
const LEGACY_PHASE_TO_STEP: Record<string, Step> = {
  harvest: 'harvest',
  spec: 'draft_spec',
  clarify: 'questions',
  plan: 'draft_plan',
  decompose: 'decompose',
  implement: 'implement',
  verify: 'verify',
  repair: 'repair',
  review: 'auto_review',
  human_review: 'human_review',
};

/**
 * Legacy phase names that are still phases. `done` folds into `ship`: it was
 * never a stage of work, only a marker for a terminal status, and the
 * `status_changed` event beside it already records that.
 */
const LEGACY_PHASE_TO_PHASE: Record<string, Phase> = {
  intake: 'intake',
  ship: 'ship',
  done: 'ship',
};

/**
 * Legacy phases with no 2.0.0 equivalent. `wait_for_ci` was carried as a
 * skipped phase per the old §20.3 (DECISIONS D3) and defaulted off, so no run
 * ever entered it; §5.8 replaces it by re-running the ladder on the rebased
 * tree. An event naming it is dropped and counted, never dropped in silence.
 */
const RETIRED_PHASES = new Set(['wait_for_ci']);

export interface MigrationCount {
  migrated: number;
  dropped: number;
}

export function emptyMigrationCount(): MigrationCount {
  return { migrated: 0, dropped: 0 };
}

/**
 * Bring one raw log line up to the current schema, in place of nothing: an
 * event this cannot map is returned as `undefined` so the caller counts it
 * rather than letting `RunEvent.safeParse` discard it unnoticed.
 */
export function migrateRawEvent(raw: unknown, count?: MigrationCount): unknown | undefined {
  if (raw === null || typeof raw !== 'object') return raw;
  const e = raw as Record<string, unknown>;

  if (e['t'] === 'phase_entered' && typeof e['phase'] === 'string') {
    const legacy = e['phase'];
    if (RETIRED_PHASES.has(legacy)) {
      if (count) count.dropped += 1;
      return undefined;
    }
    const step = LEGACY_PHASE_TO_STEP[legacy];
    if (step) {
      if (count) count.migrated += 1;
      const { phase: _drop, ...rest } = e;
      return { ...rest, t: 'step_entered', step };
    }
    const phase = LEGACY_PHASE_TO_PHASE[legacy];
    if (phase && phase !== legacy) {
      if (count) count.migrated += 1;
      return { ...e, phase };
    }
    return raw;
  }

  // A question records the phase that raised it, so it carries the old
  // vocabulary too — and an unmigrated one would fail the enum and vanish.
  if (e['t'] === 'question_asked' && e['question'] !== null && typeof e['question'] === 'object') {
    const q = e['question'] as Record<string, unknown>;
    const legacy = q['phase'];
    if (typeof legacy === 'string' && !isCurrentPhase(legacy)) {
      const step = LEGACY_PHASE_TO_STEP[legacy];
      const phase = step ? PHASE_OF_STEP[step] : LEGACY_PHASE_TO_PHASE[legacy];
      if (phase) {
        if (count) count.migrated += 1;
        return { ...e, question: { ...q, phase } };
      }
    }
  }

  return raw;
}

function isCurrentPhase(value: string): value is Phase {
  return Object.values(PHASE_OF_STEP).includes(value as Phase);
}
